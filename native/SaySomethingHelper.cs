// SaySomethingHelper.exe — native helper for SaySomething (local-first Windows voice dictation).
//
// Persistent child process spoken to by the Electron main process over
// stdin/stdout using a JSON-lines protocol (see docs/CONTRACTS.md).
//
// Responsibilities:
//   * Low-level keyboard hook (WH_KEYBOARD_LL) reporting ONLY watched VKs
//     (hotkey + Esc while recording) plus a one-shot "capture next key" mode.
//     Injected input (LLKHF_INJECTED) is ignored so our own Ctrl+V / typing
//     never feeds back. No other keystroke is ever buffered, logged or emitted.
//   * Text injection: clipboard-swap paste (save clipboard -> set text ->
//     SendInput Ctrl+V -> restore after a delay) and a KEYEVENTF_UNICODE
//     "type" fallback.
//   * Foreground window info (exe name + title) on request.
//
// IMPORTANT: this file is compiled by the .NET Framework compiler shipped with
// Windows (csc.exe v4.0.30319), which supports C# 5 ONLY. Do NOT use string
// interpolation, null-conditional (?.), nameof, expression-bodied members,
// out var, pattern matching or tuples. async/await is available but unused.
//
// Threads:
//   * main   — reads stdin lines, dispatches commands, emits ping/foreground.
//   * hook   — installs the keyboard hook and runs a message loop (required).
//   * sta    — STA worker that owns all clipboard access + input injection.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class SaySomethingHelper
{
    // ---- Win32 constants -------------------------------------------------

    const int WH_KEYBOARD_LL = 13;
    const int WH_MOUSE_LL = 14;
    const int WM_KEYDOWN = 0x0100;
    const int WM_KEYUP = 0x0101;
    const int WM_SYSKEYDOWN = 0x0104;
    const int WM_SYSKEYUP = 0x0105;
    const int WM_LBUTTONDOWN = 0x0201;
    const uint LLMHF_INJECTED = 0x00000001;

    const uint LLKHF_INJECTED = 0x00000010;
    const uint LLKHF_LOWER_IL_INJECTED = 0x00000002;

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    const ushort VK_CONTROL = 0x11;
    const ushort VK_V = 0x56;
    const ushort VK_RETURN = 0x0D;

    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    // ---- Win32 structs ---------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int pt_x;
        public int pt_y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    // ---- Win32 imports ---------------------------------------------------

    delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    // Cursor + click for the "place at a point" pad drop (SetCursorPos + a left
    // click focuses the target field and drops the caret, then we paste).
    [DllImport("user32.dll")]
    static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);

    // ---- Shared state ----------------------------------------------------

    static System.IO.TextWriter _out;
    static System.IO.TextReader _in;
    static readonly object _outLock = new object();

    // Immutable set swapped atomically; hook thread reads, main thread writes.
    static volatile HashSet<int> _watched = new HashSet<int>();
    static volatile bool _captureArmed = false;
    // One-shot rebind capture auto-disarms after this long if no key arrives, so an
    // abandoned rebind can never later transmit an unrelated keystroke (privacy).
    const int CAPTURE_TIMEOUT_MS = 15000;
    static readonly object _captureLock = new object();
    // Modifier VKs held during an armed chord-capture (issue #1). Guarded by
    // _captureLock; resolving the chord (trigger key) clears this.
    static readonly HashSet<int> _captureMods = new HashSet<int>();
    // Fully qualified: System.Windows.Forms is also imported and defines a Timer.
    static System.Threading.Timer _captureTimer;

    static IntPtr _hookHandle = IntPtr.Zero;
    // Keep the delegate rooted so it is not garbage-collected while installed.
    static LowLevelKeyboardProc _hookProc;

    // One-shot mouse "pick a point" for the drop pad: armed on demand, reports the
    // NEXT left-click's screen coords once, then disarms. Never tracks the mouse
    // otherwise (same privacy model as the watched-keys-only keyboard hook).
    static IntPtr _mouseHookHandle = IntPtr.Zero;
    static LowLevelKeyboardProc _mouseProc; // same (nCode,wParam,lParam) signature
    static volatile bool _pickArmed = false;
    const int PICK_TIMEOUT_MS = 20000;
    static readonly object _pickLock = new object();
    static System.Threading.Timer _pickTimer;

    static bool _warnedNonText = false;

    // STA injection worker queue.
    static readonly object _jobLock = new object();
    static readonly Queue<Job> _jobs = new Queue<Job>();

    class Job
    {
        public int kind;        // 0 = paste, 1 = type, 2 = clipboard-set, 3 = placeAt
        public string text;
        public int restoreMs;
        public int x;           // screen point for kind 3 (placeAt)
        public int y;
    }

    // ---- Entry point -----------------------------------------------------

    static void Main()
    {
        // Own binary UTF-8 streams over the redirected pipes; this avoids the
        // Console encoding pitfalls that occur with /target:winexe.
        UTF8Encoding enc = new UTF8Encoding(false);
        System.IO.StreamWriter w = new System.IO.StreamWriter(Console.OpenStandardOutput(), enc);
        w.AutoFlush = true;
        w.NewLine = "\n";
        _out = w;
        _in = new System.IO.StreamReader(Console.OpenStandardInput(), enc);

        // Injection worker (STA — required for System.Windows.Forms.Clipboard).
        Thread sta = new Thread(new ThreadStart(StaWorker));
        sta.IsBackground = true;
        sta.SetApartmentState(ApartmentState.STA);
        sta.Start();

        // Keyboard hook + message loop on its own thread.
        Thread hook = new Thread(new ThreadStart(HookThreadProc));
        hook.IsBackground = true;
        hook.Start();

        // Command loop. Exits (returns null) when the parent closes stdin.
        string line;
        while (true)
        {
            try
            {
                line = _in.ReadLine();
            }
            catch (Exception)
            {
                line = null;
            }
            if (line == null) break;
            line = line.Trim();
            if (line.Length == 0) continue;
            try
            {
                HandleCommand(line);
            }
            catch (Exception ex)
            {
                EmitLog("command error: " + ex.Message);
            }
        }

        // Parent died / asked to quit — tear down and leave.
        try { if (_hookHandle != IntPtr.Zero) UnhookWindowsHookEx(_hookHandle); }
        catch (Exception) { }
        try { if (_mouseHookHandle != IntPtr.Zero) UnhookWindowsHookEx(_mouseHookHandle); }
        catch (Exception) { }
        Environment.Exit(0);
    }

    // ---- Command dispatch ------------------------------------------------

    static void HandleCommand(string line)
    {
        object parsed = new JsonParser(line).Parse();
        Dictionary<string, object> obj = parsed as Dictionary<string, object>;
        if (obj == null) return;

        object cmdObj;
        obj.TryGetValue("cmd", out cmdObj);
        string cmd = cmdObj as string;
        if (cmd == null) return;

        if (cmd == "ping")
        {
            EmitSimple("pong");
        }
        else if (cmd == "watch")
        {
            object vksObj;
            obj.TryGetValue("vks", out vksObj);
            List<object> arr = vksObj as List<object>;
            HashSet<int> next = new HashSet<int>();
            if (arr != null)
            {
                for (int i = 0; i < arr.Count; i++)
                {
                    object v = arr[i];
                    if (v is double)
                    {
                        int n = (int)(double)v;
                        if (n >= 0 && n <= 255) next.Add(n);
                    }
                }
            }
            _watched = next; // atomic reference swap
        }
        else if (cmd == "capture")
        {
            lock (_captureLock)
            {
                _captureArmed = true;
                _captureMods.Clear();
                if (_captureTimer == null)
                {
                    _captureTimer = new System.Threading.Timer(OnCaptureTimeout, null, CAPTURE_TIMEOUT_MS, System.Threading.Timeout.Infinite);
                }
                else
                {
                    _captureTimer.Change(CAPTURE_TIMEOUT_MS, System.Threading.Timeout.Infinite);
                }
            }
        }
        else if (cmd == "capture-cancel")
        {
            DisarmCapture();
        }
        else if (cmd == "paste")
        {
            object t;
            obj.TryGetValue("text", out t);
            string text = t as string;
            if (text == null) text = "";
            int restoreMs = 300;
            object r;
            obj.TryGetValue("restoreMs", out r);
            if (r is double) restoreMs = (int)(double)r;
            if (restoreMs < 0) restoreMs = 0;
            EnqueueJob(0, text, restoreMs);
        }
        else if (cmd == "type")
        {
            object t;
            obj.TryGetValue("text", out t);
            string text = t as string;
            if (text == null) text = "";
            EnqueueJob(1, text, 0);
        }
        else if (cmd == "clipboard")
        {
            // Set the clipboard WITHOUT pasting (the drop pad auto-copies).
            object t;
            obj.TryGetValue("text", out t);
            string text = t as string;
            if (text == null) text = "";
            EnqueueJob(2, text, 0);
        }
        else if (cmd == "placeAt")
        {
            // Move the cursor to (x,y), click to focus + drop the caret, then paste.
            object t, ox, oy, r;
            obj.TryGetValue("text", out t);
            string text = t as string;
            if (text == null) text = "";
            int x = 0, y = 0, restoreMs = 300;
            obj.TryGetValue("x", out ox); if (ox is double) x = (int)(double)ox;
            obj.TryGetValue("y", out oy); if (oy is double) y = (int)(double)oy;
            obj.TryGetValue("restoreMs", out r); if (r is double) restoreMs = (int)(double)r;
            if (restoreMs < 0) restoreMs = 0;
            EnqueueJob(3, text, restoreMs, x, y);
        }
        else if (cmd == "pickPoint")
        {
            // Arm the one-shot mouse pick: the next left-click reports its coords.
            lock (_pickLock)
            {
                _pickArmed = true;
                if (_pickTimer == null)
                {
                    _pickTimer = new System.Threading.Timer(OnPickTimeout, null, PICK_TIMEOUT_MS, System.Threading.Timeout.Infinite);
                }
                else
                {
                    _pickTimer.Change(PICK_TIMEOUT_MS, System.Threading.Timeout.Infinite);
                }
            }
        }
        else if (cmd == "pick-cancel")
        {
            DisarmPick();
        }
        else if (cmd == "foreground")
        {
            DoForeground();
        }
        else if (cmd == "quit")
        {
            try { if (_hookHandle != IntPtr.Zero) UnhookWindowsHookEx(_hookHandle); }
            catch (Exception) { }
            try { if (_mouseHookHandle != IntPtr.Zero) UnhookWindowsHookEx(_mouseHookHandle); }
            catch (Exception) { }
            Environment.Exit(0);
        }
        // Unknown commands are ignored on purpose.
    }

    static void DisarmCapture()
    {
        lock (_captureLock) { DisarmCaptureLocked(); }
    }

    // Disarm capture and drop any accumulated modifiers. Caller MUST hold _captureLock.
    static void DisarmCaptureLocked()
    {
        _captureArmed = false;
        _captureMods.Clear();
        if (_captureTimer != null)
        {
            _captureTimer.Change(System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite);
        }
    }

    // Snapshot the held modifiers as an array. Caller MUST hold _captureLock.
    static int[] ModsSnapshot()
    {
        int[] a = new int[_captureMods.Count];
        _captureMods.CopyTo(a);
        return a;
    }

    static bool IsModifier(int vk)
    {
        return vk == 0x10 || vk == 0x11 || vk == 0x12   // generic Shift / Ctrl / Alt
            || (vk >= 0xA0 && vk <= 0xA5)                // L/R Shift, Ctrl, Alt
            || vk == 0x5B || vk == 0x5C;                 // L/R Win
    }

    // Accumulate a modifier chord during capture; resolve when a non-modifier key
    // goes DOWN (mods + that key) or a lone modifier is RELEASED (issue #1). Runs
    // on the hook thread; all shared state touched under _captureLock.
    static void HandleCaptureKey(int vk, bool down)
    {
        int[] mods = null;
        int emitVk = 0;
        bool emit = false;
        lock (_captureLock)
        {
            if (!_captureArmed) return; // raced with disarm / timeout
            bool isMod = IsModifier(vk);
            if (down)
            {
                if (isMod) { _captureMods.Add(vk); return; } // wait for the trigger
                mods = ModsSnapshot();
                emitVk = vk;
                emit = true;
                DisarmCaptureLocked();
            }
            else
            {
                if (!isMod) return;
                if (!_captureMods.Contains(vk)) return;
                // Modifier pressed + released with no trigger => bind the modifier
                // itself (e.g. bare Right Ctrl); any still-held modifiers are its mods.
                _captureMods.Remove(vk);
                mods = ModsSnapshot();
                emitVk = vk;
                emit = true;
                DisarmCaptureLocked();
            }
        }
        if (emit) EmitCaptured(emitVk, mods);
    }

    // Fires only if an armed capture was never satisfied by a keypress.
    static void OnCaptureTimeout(object state)
    {
        lock (_captureLock) { DisarmCaptureLocked(); }
    }

    static void DisarmPick()
    {
        lock (_pickLock)
        {
            _pickArmed = false;
            if (_pickTimer != null)
            {
                _pickTimer.Change(System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite);
            }
        }
    }

    // Fires only if an armed pick was never satisfied by a click.
    static void OnPickTimeout(object state)
    {
        _pickArmed = false;
    }

    static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && _pickArmed && wParam.ToInt32() == WM_LBUTTONDOWN)
        {
            try
            {
                MSLLHOOKSTRUCT m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                bool injected = (m.flags & LLMHF_INJECTED) != 0;
                if (!injected)
                {
                    _pickArmed = false;
                    EmitPicked(m.pt.x, m.pt.y);
                    return (IntPtr)1; // swallow: placeAt does the authoritative click + paste
                }
            }
            catch (Exception)
            {
                // Never let a hook exception escape.
            }
        }
        return CallNextHookEx(_mouseHookHandle, nCode, wParam, lParam);
    }

    // ---- Keyboard hook ---------------------------------------------------

    static void HookThreadProc()
    {
        _hookProc = new LowLevelKeyboardProc(HookCallback);
        try
        {
            IntPtr hMod = GetModuleHandle(null);
            _hookHandle = SetWindowsHookEx(WH_KEYBOARD_LL, _hookProc, hMod, 0);
        }
        catch (Exception)
        {
            _hookHandle = IntPtr.Zero;
        }

        if (_hookHandle == IntPtr.Zero)
        {
            EmitLog("keyboard hook could not be installed");
        }

        // Install the low-level mouse hook on this same message-loop thread. It is
        // inert unless a one-shot pick is armed; failure is non-fatal (the drop pad
        // "click to place" just won't work; everything else is unaffected).
        _mouseProc = new LowLevelKeyboardProc(MouseCallback);
        try
        {
            IntPtr hMod2 = GetModuleHandle(null);
            _mouseHookHandle = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, hMod2, 0);
        }
        catch (Exception)
        {
            _mouseHookHandle = IntPtr.Zero;
        }
        if (_mouseHookHandle == IntPtr.Zero)
        {
            EmitLog("mouse hook could not be installed");
        }

        // Signal readiness regardless: paste/type/foreground/ping still work,
        // and the parent must not hang waiting for 'ready'.
        EmitSimple("ready");

        // Message loop keeps this thread servicing both low-level hooks.
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }

    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            try
            {
                KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                bool injected = (k.flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) != 0;
                if (!injected)
                {
                    int msg = wParam.ToInt32();
                    bool down = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN);
                    bool up = (msg == WM_KEYUP || msg == WM_SYSKEYUP);
                    int vk = (int)k.vkCode;

                    if (_captureArmed && (down || up))
                    {
                        // Chord-capture: accumulate modifiers, resolve on the trigger
                        // key (issue #1). Takes over all keys while armed.
                        HandleCaptureKey(vk, down);
                    }
                    else if (down || up)
                    {
                        HashSet<int> watched = _watched;
                        if (watched.Contains(vk))
                        {
                            EmitKey(vk, down, SnapshotHeld(watched));
                        }
                    }
                }
            }
            catch (Exception)
            {
                // Never let a hook exception escape — it would drop the hook.
            }
        }
        return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
    }

    // ---- STA injection worker -------------------------------------------

    static void EnqueueJob(int kind, string text, int restoreMs)
    {
        EnqueueJob(kind, text, restoreMs, 0, 0);
    }

    static void EnqueueJob(int kind, string text, int restoreMs, int x, int y)
    {
        Job j = new Job();
        j.kind = kind;
        j.text = text;
        j.restoreMs = restoreMs;
        j.x = x;
        j.y = y;
        lock (_jobLock)
        {
            _jobs.Enqueue(j);
            Monitor.Pulse(_jobLock);
        }
    }

    static void StaWorker()
    {
        while (true)
        {
            Job j = null;
            lock (_jobLock)
            {
                while (_jobs.Count == 0)
                {
                    Monitor.Wait(_jobLock);
                }
                j = _jobs.Dequeue();
            }
            if (j == null) continue;
            if (j.kind == 0) DoPaste(j.text, j.restoreMs);
            else if (j.kind == 1) DoType(j.text);
            else if (j.kind == 2) DoCopy(j.text);
            else if (j.kind == 3) DoPlaceAt(j.x, j.y, j.text, j.restoreMs);
        }
    }

    static void DoCopy(string text)
    {
        string err = null;
        try { if (!TrySetClipboardText(text)) err = "could not set clipboard"; }
        catch (Exception ex) { err = ex.Message; }
        EmitResult("copied", err);
    }

    static void DoPlaceAt(int x, int y, string text, int restoreMs)
    {
        string err = null;
        try
        {
            bool hadText = false;
            string saved = null;
            try { hadText = Clipboard.ContainsText(); }
            catch (Exception) { hadText = false; }
            if (hadText)
            {
                try { saved = Clipboard.GetText(); }
                catch (Exception) { saved = null; hadText = false; }
            }

            if (!TrySetClipboardText(text))
            {
                err = "could not set clipboard";
            }
            else
            {
                // Focus the target under the drop point and drop the caret there.
                try { SetCursorPos(x, y); } catch (Exception) { }
                Thread.Sleep(10);
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
                Thread.Sleep(30);
                uint sent = SendCtrlV();
                if (sent == 0) err = "SendInput failed";
                Thread.Sleep(restoreMs);
                if (hadText) TrySetClipboardText(saved); // best-effort restore
            }
        }
        catch (Exception ex)
        {
            err = ex.Message;
        }
        EmitResult("placed", err);
    }

    static void DoPaste(string text, int restoreMs)
    {
        string err = null;
        try
        {
            bool hadText = false;
            string saved = null;
            try { hadText = Clipboard.ContainsText(); }
            catch (Exception) { hadText = false; }

            if (hadText)
            {
                try { saved = Clipboard.GetText(); }
                catch (Exception) { saved = null; hadText = false; }
            }
            else
            {
                bool nonText = false;
                try
                {
                    IDataObject d = Clipboard.GetDataObject();
                    if (d != null)
                    {
                        string[] fmts = d.GetFormats();
                        if (fmts != null && fmts.Length > 0) nonText = true;
                    }
                }
                catch (Exception) { }
                if (nonText && !_warnedNonText)
                {
                    _warnedNonText = true;
                    // Non-text clipboard content is not saved/restored; our
                    // pasted text is left on the clipboard afterwards.
                    EmitLog("clipboard held non-text content; leaving pasted text on the clipboard");
                }
            }

            if (!TrySetClipboardText(text))
            {
                err = "could not set clipboard";
            }
            else
            {
                uint sent = SendCtrlV();
                if (sent == 0) err = "SendInput failed";
                Thread.Sleep(restoreMs);
                if (hadText)
                {
                    TrySetClipboardText(saved); // best-effort restore
                }
            }
        }
        catch (Exception ex)
        {
            err = ex.Message;
        }
        EmitResult("pasted", err);
    }

    static void DoType(string text)
    {
        string err = null;
        try
        {
            uint sent = SendUnicode(text);
            // sent == 0 with a non-empty string means SendInput failed.
            if (sent == 0 && !string.IsNullOrEmpty(text)) err = "SendInput failed";
        }
        catch (Exception ex)
        {
            err = ex.Message;
        }
        EmitResult("typed", err);
    }

    static bool TrySetClipboardText(string s)
    {
        for (int i = 0; i < 6; i++)
        {
            try
            {
                if (string.IsNullOrEmpty(s)) Clipboard.Clear();
                else Clipboard.SetText(s);
                return true;
            }
            catch (Exception)
            {
                Thread.Sleep(15);
            }
        }
        return false;
    }

    static uint SendCtrlV()
    {
        INPUT[] inp = new INPUT[4];
        inp[0] = VkInput(VK_CONTROL, false);
        inp[1] = VkInput(VK_V, false);
        inp[2] = VkInput(VK_V, true);
        inp[3] = VkInput(VK_CONTROL, true);
        return SendInput((uint)inp.Length, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static uint SendUnicode(string text)
    {
        List<INPUT> list = new List<INPUT>();
        foreach (char c in text)
        {
            if (c == '\r') continue;
            if (c == '\n')
            {
                list.Add(VkInput(VK_RETURN, false));
                list.Add(VkInput(VK_RETURN, true));
            }
            else
            {
                list.Add(UnicodeInput(c, false));
                list.Add(UnicodeInput(c, true));
            }
        }
        if (list.Count == 0) return 0;
        INPUT[] arr = list.ToArray();
        return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
    }

    static INPUT VkInput(ushort vk, bool up)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = vk;
        i.U.ki.wScan = 0;
        i.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        i.U.ki.time = 0;
        i.U.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    static INPUT UnicodeInput(char c, bool up)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = 0;
        i.U.ki.wScan = (ushort)c;
        i.U.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        i.U.ki.time = 0;
        i.U.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    // ---- Foreground window ----------------------------------------------

    static void DoForeground()
    {
        string exe = "";
        string title = "";
        try
        {
            IntPtr hWnd = GetForegroundWindow();
            if (hWnd != IntPtr.Zero)
            {
                int len = GetWindowTextLength(hWnd);
                if (len > 0)
                {
                    StringBuilder sb = new StringBuilder(len + 2);
                    GetWindowText(hWnd, sb, sb.Capacity);
                    title = sb.ToString();
                }
                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid != 0)
                {
                    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                    if (h != IntPtr.Zero)
                    {
                        try
                        {
                            StringBuilder pb = new StringBuilder(1024);
                            uint cap = (uint)pb.Capacity;
                            if (QueryFullProcessImageName(h, 0, pb, ref cap))
                            {
                                string full = pb.ToString();
                                int slash = full.LastIndexOf('\\');
                                exe = (slash >= 0) ? full.Substring(slash + 1) : full;
                            }
                        }
                        finally
                        {
                            CloseHandle(h);
                        }
                    }
                }
            }
        }
        catch (Exception)
        {
            // Emit whatever we managed to gather.
        }
        EmitForeground(exe, title);
    }

    // ---- Emit (thread-safe, one JSON object per line) --------------------

    static void Emit(string json)
    {
        lock (_outLock)
        {
            try
            {
                _out.Write(json);
                _out.Write("\n");
                _out.Flush();
            }
            catch (Exception)
            {
                // If the pipe is gone the parent is dead; nothing to do.
            }
        }
    }

    static void EmitSimple(string evt)
    {
        Emit("{\"evt\":\"" + evt + "\"}");
    }

    static void EmitKey(int vk, bool down, int[] held)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"evt\":\"key\",\"vk\":");
        sb.Append(vk);
        sb.Append(",\"down\":");
        sb.Append(down ? "true" : "false");
        sb.Append(",\"held\":[");
        if (held != null)
        {
            for (int i = 0; i < held.Length; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append(held[i]);
            }
        }
        sb.Append("]}");
        Emit(sb.ToString());
    }

    // Real-time physical state of the watched keys (immune to key-ups missed across
    // a UAC / lock-screen transition). GetAsyncKeyState high bit = currently down.
    static int[] SnapshotHeld(HashSet<int> watched)
    {
        List<int> held = new List<int>();
        foreach (int k in watched)
        {
            if ((GetAsyncKeyState(k) & 0x8000) != 0) held.Add(k);
        }
        return held.ToArray();
    }

    static void EmitCaptured(int vk, int[] mods)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"evt\":\"captured\",\"vk\":");
        sb.Append(vk);
        sb.Append(",\"name\":");
        sb.Append(JStr(VkName(vk)));
        sb.Append(",\"mods\":[");
        if (mods != null)
        {
            for (int i = 0; i < mods.Length; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append(mods[i]);
            }
        }
        sb.Append("]}");
        Emit(sb.ToString());
    }

    static void EmitPicked(int x, int y)
    {
        Emit("{\"evt\":\"picked\",\"x\":" + x + ",\"y\":" + y + "}");
    }

    static void EmitResult(string evt, string err)
    {
        if (err == null)
        {
            Emit("{\"evt\":\"" + evt + "\",\"ok\":true}");
        }
        else
        {
            Emit("{\"evt\":\"" + evt + "\",\"ok\":false,\"err\":" + JStr(err) + "}");
        }
    }

    static void EmitForeground(string exe, string title)
    {
        Emit("{\"evt\":\"foreground\",\"exe\":" + JStr(exe) + ",\"title\":" + JStr(title) + "}");
    }

    static void EmitLog(string msg)
    {
        Emit("{\"evt\":\"log\",\"msg\":" + JStr(msg) + "}");
    }

    // ---- Minimal JSON --------------------------------------------------

    static string JStr(string s)
    {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\b') sb.Append("\\b");
            else if (c == '\f') sb.Append("\\f");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 0x20)
            {
                sb.Append("\\u");
                sb.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            }
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }

    // Recursive-descent parser for the fixed command protocol. Produces
    // Dictionary<string,object> / List<object> / string / double / bool / null.
    class JsonParser
    {
        readonly string s;
        int i;

        public JsonParser(string str)
        {
            s = (str == null) ? "" : str;
            i = 0;
        }

        public object Parse()
        {
            SkipWs();
            return ParseValue();
        }

        void SkipWs()
        {
            while (i < s.Length)
            {
                char c = s[i];
                if (c == ' ' || c == '\t' || c == '\r' || c == '\n') i++;
                else break;
            }
        }

        object ParseValue()
        {
            SkipWs();
            if (i >= s.Length) return null;
            char c = s[i];
            if (c == '{') return ParseObject();
            if (c == '[') return ParseArray();
            if (c == '"') return ParseString();
            if (c == 't' || c == 'f') return ParseBool();
            if (c == 'n') { Skip(4); return null; }
            return ParseNumber();
        }

        void Skip(int n)
        {
            i += n;
            if (i > s.Length) i = s.Length;
        }

        Dictionary<string, object> ParseObject()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            i++; // consume '{'
            SkipWs();
            if (i < s.Length && s[i] == '}') { i++; return d; }
            while (i < s.Length)
            {
                SkipWs();
                if (i >= s.Length || s[i] != '"') break;
                string key = ParseString();
                SkipWs();
                if (i < s.Length && s[i] == ':') i++;
                object val = ParseValue();
                d[key] = val;
                SkipWs();
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == '}') { i++; break; }
                break;
            }
            return d;
        }

        List<object> ParseArray()
        {
            List<object> l = new List<object>();
            i++; // consume '['
            SkipWs();
            if (i < s.Length && s[i] == ']') { i++; return l; }
            while (i < s.Length)
            {
                object val = ParseValue();
                l.Add(val);
                SkipWs();
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == ']') { i++; break; }
                break;
            }
            return l;
        }

        string ParseString()
        {
            StringBuilder sb = new StringBuilder();
            i++; // consume opening quote
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') break;
                if (c == '\\')
                {
                    if (i >= s.Length) break;
                    char e = s[i++];
                    if (e == '"') sb.Append('"');
                    else if (e == '\\') sb.Append('\\');
                    else if (e == '/') sb.Append('/');
                    else if (e == 'b') sb.Append('\b');
                    else if (e == 'f') sb.Append('\f');
                    else if (e == 'n') sb.Append('\n');
                    else if (e == 'r') sb.Append('\r');
                    else if (e == 't') sb.Append('\t');
                    else if (e == 'u')
                    {
                        if (i + 4 <= s.Length)
                        {
                            string hex = s.Substring(i, 4);
                            i += 4;
                            int code = 0;
                            if (int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                            {
                                sb.Append((char)code);
                            }
                        }
                    }
                    else sb.Append(e);
                }
                else sb.Append(c);
            }
            return sb.ToString();
        }

        bool ParseBool()
        {
            if (i < s.Length && s[i] == 't') { Skip(4); return true; }
            Skip(5);
            return false;
        }

        double ParseNumber()
        {
            int start = i;
            while (i < s.Length)
            {
                char c = s[i];
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') i++;
                else break;
            }
            string num = s.Substring(start, i - start);
            double d = 0;
            double.TryParse(num, NumberStyles.Any, CultureInfo.InvariantCulture, out d);
            return d;
        }
    }

    // ---- VK -> friendly name (for rebind capture) ------------------------

    static string VkName(int vk)
    {
        switch (vk)
        {
            case 0x08: return "Backspace";
            case 0x09: return "Tab";
            case 0x0D: return "Enter";
            case 0x13: return "Pause";
            case 0x14: return "Caps Lock";
            case 0x1B: return "Esc";
            case 0x20: return "Space";
            case 0x21: return "Page Up";
            case 0x22: return "Page Down";
            case 0x23: return "End";
            case 0x24: return "Home";
            case 0x25: return "Left";
            case 0x26: return "Up";
            case 0x27: return "Right";
            case 0x28: return "Down";
            case 0x2C: return "Print Screen";
            case 0x2D: return "Insert";
            case 0x2E: return "Delete";
            case 0x5B: return "Left Win";
            case 0x5C: return "Right Win";
            case 0x5D: return "Menu";
            case 0x90: return "Num Lock";
            case 0x91: return "Scroll Lock";
            case 0xA0: return "Left Shift";
            case 0xA1: return "Right Shift";
            case 0xA2: return "Left Ctrl";
            case 0xA3: return "Right Ctrl";
            case 0xA4: return "Left Alt";
            case 0xA5: return "Right Alt";
            case 0x10: return "Shift";
            case 0x11: return "Ctrl";
            case 0x12: return "Alt";
            case 0x6A: return "Numpad *";
            case 0x6B: return "Numpad +";
            case 0x6D: return "Numpad -";
            case 0x6E: return "Numpad .";
            case 0x6F: return "Numpad /";
            case 0xBA: return ";";
            case 0xBB: return "=";
            case 0xBC: return ",";
            case 0xBD: return "-";
            case 0xBE: return ".";
            case 0xBF: return "/";
            case 0xC0: return "`";
            case 0xDB: return "[";
            case 0xDC: return "\\";
            case 0xDD: return "]";
            case 0xDE: return "'";
        }
        if (vk >= 0x41 && vk <= 0x5A) return ((char)vk).ToString();          // A-Z
        if (vk >= 0x30 && vk <= 0x39) return ((char)vk).ToString();          // 0-9
        if (vk >= 0x60 && vk <= 0x69) return "Numpad " + (vk - 0x60);        // Numpad 0-9
        if (vk >= 0x70 && vk <= 0x87) return "F" + (vk - 0x6F);              // F1-F24
        return "VK " + vk;
    }
}
