// SaySomethingHelper — native helper for SaySomething (local-first voice dictation).
//
// macOS port of native/SaySomethingHelper.cs. A persistent child process spoken
// to by the Electron main process over stdin/stdout using the SAME JSON-lines
// protocol as the Windows helper (see docs/CONTRACTS.md), plus the mac-only
// `perms` protocol (docs/MAC-PORT-ADDENDUM.md).
//
// Responsibilities (mirrors the C# helper's observable behavior):
//   * A CGEventTap on keyDown/keyUp/flagsChanged reporting ONLY watched VKs
//     (hotkey + Esc while recording) plus a one-shot chord/rebind capture mode.
//     Self-injected events (our own Cmd+V / typing / clicks) are tagged with a
//     magic eventSourceUserData and ignored so they never feed back. No other
//     keystroke is ever buffered, logged or emitted.
//   * A one-shot mouse pick (leftMouseDown/Up on the same tap) for the drop pad.
//   * Text injection: clipboard-swap paste (save pasteboard -> set text ->
//     synthesize Cmd+V -> restore after a delay), a unicode `type` fallback, a
//     `clipboard` set-without-paste, and `placeAt` (warp + click + paste).
//   * Frontmost app name on request (NSWorkspace, no TCC needed).
//   * TCC permission status reporting + prompt triggers over stdio.
//
// The helper translates CGKeyCode <-> Windows VK at the boundary: ALL stdio
// speaks Windows VK numbers so the JS layer and saved settings stay portable;
// CGKeyCodes never leak out. See the tables below (mirror of the C# VkName()).
//
// Threads:
//   * main  — reads stdin lines, dispatches commands, emits ping/perms.
//   * tap   — owns a CFRunLoop, the CGEventTap, the 2s perms/watchdog poll.
//   * inject (serial DispatchQueue) — clipboard + CGEvent injection + foreground.
//
// Built as a single-file swiftc command-line tool (no app bundle). Default
// language mode (Swift 5) — no strict-concurrency actors; shared state is guarded
// by plain locks. The CGEventTap C callback captures no context (refcon-free): it
// is a top-level function that reaches the global `gHelper` singleton.

import Foundation
import CoreGraphics
import AppKit
import ApplicationServices

// ===================================================================
// MARK: - Constants
// ===================================================================

// Distinctive tag stamped on every event we synthesize, so the tap can ignore
// our own Cmd+V / unicode / click events (mirrors the LLKHF_INJECTED check).
let MAGIC: Int64 = 0x5359_5353  // "SYSS"

let CAPTURE_TIMEOUT_MS = 15000
let PICK_TIMEOUT_MS = 20000

// kVK_ANSI_V — the physical keycode for "V"; Cmd+V is the paste chord on mac.
let KVK_ANSI_V: CGKeyCode = 0x09

// ===================================================================
// MARK: - Output (thread-safe, one JSON object per line, UTF-8)
// ===================================================================

let outLock = NSLock()

func emitRaw(_ json: String) {
    outLock.lock()
    defer { outLock.unlock() }
    fputs(json, stdout)
    fputs("\n", stdout)
    fflush(stdout)
}

// JSON-escape a string value (mirrors the C# JStr()).
func jstr(_ s: String) -> String {
    var out = "\""
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\u{08}": out += "\\b"
        case "\u{0C}": out += "\\f"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    out += "\""
    return out
}

func emitSimple(_ evt: String) { emitRaw("{\"evt\":\"\(evt)\"}") }

func emitKey(_ vk: Int, _ down: Bool, _ held: [Int]) {
    let h = held.map { String($0) }.joined(separator: ",")
    emitRaw("{\"evt\":\"key\",\"vk\":\(vk),\"down\":\(down ? "true" : "false"),\"held\":[\(h)]}")
}

func emitCaptured(_ vk: Int, _ mods: [Int]) {
    let m = mods.map { String($0) }.joined(separator: ",")
    emitRaw("{\"evt\":\"captured\",\"vk\":\(vk),\"name\":\(jstr(vkName(vk))),\"mods\":[\(m)]}")
}

func emitPicked(_ x: Int, _ y: Int) {
    emitRaw("{\"evt\":\"picked\",\"x\":\(x),\"y\":\(y)}")
}

func emitResult(_ evt: String, _ err: String?) {
    if let e = err {
        emitRaw("{\"evt\":\"\(evt)\",\"ok\":false,\"err\":\(jstr(e))}")
    } else {
        emitRaw("{\"evt\":\"\(evt)\",\"ok\":true}")
    }
}

func emitForeground(_ exe: String, _ title: String) {
    emitRaw("{\"evt\":\"foreground\",\"exe\":\(jstr(exe)),\"title\":\(jstr(title))}")
}

func emitLog(_ msg: String) {
    emitRaw("{\"evt\":\"log\",\"msg\":\(jstr(msg))}")
}

func emitPerms(_ listen: Bool, _ ax: Bool) {
    emitRaw("{\"evt\":\"perms\",\"listen\":\(listen ? "true" : "false"),\"ax\":\(ax ? "true" : "false")}")
}

// ===================================================================
// MARK: - CGKeyCode <-> Windows VK tables (mirror of the C# VkName())
// ===================================================================

// Physical keycode (CGKeyCode) -> Windows Virtual-Key. Covers the ~90 keys the
// C# VkName() knows about: the L/R modifier map from the addendum plus the ANSI
// letters/digits/punctuation/F-keys/keypad and navigation cluster.
let keycodeToVK: [Int: Int] = [
    // Physical modifiers (addendum table)
    0x38: 0xA0,  // Shift        -> LShift 160
    0x3C: 0xA1,  // Right Shift  -> RShift 161
    0x3B: 0xA2,  // Control      -> LCtrl  162
    0x3E: 0xA3,  // Right Ctrl   -> RCtrl  163
    0x3A: 0xA4,  // Option       -> LAlt   164
    0x3D: 0xA5,  // Right Option -> RAlt   165
    0x37: 0x5B,  // Command      -> LWin   91
    0x36: 0x5C,  // Right Command-> RWin   92
    0x35: 0x1B,  // Esc          -> 27

    // ANSI letters
    0x00: 0x41, 0x0B: 0x42, 0x08: 0x43, 0x02: 0x44, 0x0E: 0x45, 0x03: 0x46,
    0x05: 0x47, 0x04: 0x48, 0x22: 0x49, 0x26: 0x4A, 0x28: 0x4B, 0x25: 0x4C,
    0x2E: 0x4D, 0x2D: 0x4E, 0x1F: 0x4F, 0x23: 0x50, 0x0C: 0x51, 0x0F: 0x52,
    0x01: 0x53, 0x11: 0x54, 0x20: 0x55, 0x09: 0x56, 0x0D: 0x57, 0x07: 0x58,
    0x10: 0x59, 0x06: 0x5A,

    // Top-row digits
    0x1D: 0x30, 0x12: 0x31, 0x13: 0x32, 0x14: 0x33, 0x15: 0x34, 0x17: 0x35,
    0x16: 0x36, 0x1A: 0x37, 0x1C: 0x38, 0x19: 0x39,

    // Punctuation / OEM keys
    0x18: 0xBB,  // =    (VK_OEM_PLUS)
    0x1B: 0xBD,  // -    (VK_OEM_MINUS)
    0x21: 0xDB,  // [
    0x1E: 0xDD,  // ]
    0x2A: 0xDC,  // backslash
    0x29: 0xBA,  // ;
    0x27: 0xDE,  // '
    0x2B: 0xBC,  // ,
    0x2F: 0xBE,  // .
    0x2C: 0xBF,  // /
    0x32: 0xC0,  // `

    // Whitespace / editing / navigation
    0x24: 0x0D,  // Return -> Enter
    0x4C: 0x0D,  // Keypad Enter -> Enter
    0x30: 0x09,  // Tab
    0x31: 0x20,  // Space
    0x33: 0x08,  // Delete (backspace)
    0x75: 0x2E,  // ForwardDelete -> Delete
    0x39: 0x14,  // Caps Lock
    0x72: 0x2D,  // Help -> Insert
    0x73: 0x24,  // Home
    0x77: 0x23,  // End
    0x74: 0x21,  // Page Up
    0x79: 0x22,  // Page Down
    0x7B: 0x25,  // Left
    0x7C: 0x27,  // Right
    0x7D: 0x28,  // Down
    0x7E: 0x26,  // Up

    // Keypad
    0x52: 0x60, 0x53: 0x61, 0x54: 0x62, 0x55: 0x63, 0x56: 0x64, 0x57: 0x65,
    0x58: 0x66, 0x59: 0x67, 0x5B: 0x68, 0x5C: 0x69,
    0x43: 0x6A,  // Keypad *
    0x45: 0x6B,  // Keypad +
    0x4E: 0x6D,  // Keypad -
    0x41: 0x6E,  // Keypad .
    0x4B: 0x6F,  // Keypad /
    0x47: 0x90,  // Keypad Clear -> Num Lock

    // Function keys
    0x7A: 0x70, 0x78: 0x71, 0x63: 0x72, 0x76: 0x73, 0x60: 0x74, 0x61: 0x75,
    0x62: 0x76, 0x64: 0x77, 0x65: 0x78, 0x6D: 0x79, 0x67: 0x7A, 0x6F: 0x7B,
    0x69: 0x7C, 0x6B: 0x7D, 0x71: 0x7E, 0x6A: 0x7F, 0x40: 0x80, 0x4F: 0x81,
    0x50: 0x82, 0x5A: 0x83,
]

// Inverse map for the single-keycode (non-generic) VKs, used by watch{} and the
// held snapshot. Generic modifier VKs (16/17/18/91) are handled specially so
// they match BOTH physical sides (see keycodesForWatchedVK()).
let vkToKeycode: [Int: Int] = {
    var m = [Int: Int]()
    for (kc, vk) in keycodeToVK where m[vk] == nil { m[vk] = kc }
    // Prefer the canonical physical keycodes for the modifiers over any alias.
    m[0xA0] = 0x38; m[0xA1] = 0x3C; m[0xA2] = 0x3B; m[0xA3] = 0x3E
    m[0xA4] = 0x3A; m[0xA5] = 0x3D; m[0x5B] = 0x37; m[0x5C] = 0x36
    m[0x1B] = 0x35; m[0x0D] = 0x24
    return m
}()

// A watched Windows VK -> the CGKeyCode(s) that satisfy it. Generic modifier VKs
// expand to both physical sides (addendum: "generic 16/17/18/91 ... match both
// sides"); everything else maps to its single physical keycode.
func keycodesForWatchedVK(_ vk: Int) -> [Int] {
    switch vk {
    case 0x10: return [0x38, 0x3C]  // generic Shift -> L/R Shift
    case 0x11: return [0x3B, 0x3E]  // generic Ctrl  -> L/R Control
    case 0x12: return [0x3A, 0x3D]  // generic Alt   -> L/R Option
    case 0x5B: return [0x37, 0x36]  // generic Win / LWin -> both Command keys
    default:
        if let kc = vkToKeycode[vk] { return [kc] }
        return []
    }
}

// Which modifier-flag class a physical modifier keycode belongs to. On a
// flagsChanged event the keycode identifies the physical key and the presence of
// its flag class in event.flags tells us down (present) vs up (absent).
func modifierFlagClass(forKeycode kc: Int) -> CGEventFlags? {
    switch kc {
    case 0x38, 0x3C: return .maskShift
    case 0x3B, 0x3E: return .maskControl
    case 0x3A, 0x3D: return .maskAlternate
    case 0x37, 0x36: return .maskCommand
    default: return nil  // caps lock (0x39), fn (0x3F), etc. — not watchable
    }
}

func isModifierVK(_ vk: Int) -> Bool {
    return vk == 0x10 || vk == 0x11 || vk == 0x12         // generic Shift/Ctrl/Alt
        || (vk >= 0xA0 && vk <= 0xA5)                     // L/R Shift, Ctrl, Alt
        || vk == 0x5B || vk == 0x5C                       // L/R Win / Cmd
}

// VK -> friendly name for rebind display. Mirrors the C# VkName() with mac naming
// (Option not Alt, Cmd not Win).
func vkName(_ vk: Int) -> String {
    switch vk {
    case 0x08: return "Backspace"
    case 0x09: return "Tab"
    case 0x0D: return "Enter"
    case 0x13: return "Pause"
    case 0x14: return "Caps Lock"
    case 0x1B: return "Esc"
    case 0x20: return "Space"
    case 0x21: return "Page Up"
    case 0x22: return "Page Down"
    case 0x23: return "End"
    case 0x24: return "Home"
    case 0x25: return "Left"
    case 0x26: return "Up"
    case 0x27: return "Right"
    case 0x28: return "Down"
    case 0x2C: return "Print Screen"
    case 0x2D: return "Insert"
    case 0x2E: return "Delete"
    case 0x5B: return "Left Cmd"
    case 0x5C: return "Right Cmd"
    case 0x5D: return "Menu"
    case 0x90: return "Num Lock"
    case 0x91: return "Scroll Lock"
    case 0xA0: return "Left Shift"
    case 0xA1: return "Right Shift"
    case 0xA2: return "Left Ctrl"
    case 0xA3: return "Right Ctrl"
    case 0xA4: return "Left Option"
    case 0xA5: return "Right Option"
    case 0x10: return "Shift"
    case 0x11: return "Ctrl"
    case 0x12: return "Option"
    case 0x6A: return "Numpad *"
    case 0x6B: return "Numpad +"
    case 0x6D: return "Numpad -"
    case 0x6E: return "Numpad ."
    case 0x6F: return "Numpad /"
    case 0xBA: return ";"
    case 0xBB: return "="
    case 0xBC: return ","
    case 0xBD: return "-"
    case 0xBE: return "."
    case 0xBF: return "/"
    case 0xC0: return "`"
    case 0xDB: return "["
    case 0xDC: return "\\"
    case 0xDD: return "]"
    case 0xDE: return "'"
    default:
        if vk >= 0x41 && vk <= 0x5A { return String(UnicodeScalar(UInt8(vk))) }       // A-Z
        if vk >= 0x30 && vk <= 0x39 { return String(UnicodeScalar(UInt8(vk))) }       // 0-9
        if vk >= 0x60 && vk <= 0x69 { return "Numpad \(vk - 0x60)" }                  // Numpad 0-9
        if vk >= 0x70 && vk <= 0x87 { return "F\(vk - 0x6F)" }                        // F1-F24
        return "VK \(vk)"
    }
}

// ===================================================================
// MARK: - Small JSON helpers for incoming commands
// ===================================================================

func asInt(_ any: Any?) -> Int? {
    if let n = any as? NSNumber { return n.intValue }
    if let i = any as? Int { return i }
    if let d = any as? Double { return Int(d) }
    return nil
}

func asString(_ any: Any?) -> String? {
    return any as? String
}

// ===================================================================
// MARK: - Helper singleton (tap + state + injection)
// ===================================================================

final class Helper {
    // Shared state guarded by stateLock (tap thread reads, command thread writes).
    let stateLock = NSLock()
    var watchedVKs = Set<Int>()
    var watchedKeycodes = Set<Int>()
    var captureArmed = false
    var captureMods = [Int]()   // ordered; mirrors the C# accumulation set
    var captureGen = 0
    var pickArmed = false
    var pickGen = 0
    var swallowNextMouseUp = false
    var tapIsDefault = false     // true when the tap can swallow (.defaultTap)
    var downModifierKeycodes = Set<Int>()  // physical modifier keys we've seen go down

    // Perms bookkeeping (guarded by permsLock).
    let permsLock = NSLock()
    var lastListen = false
    var lastAx = false
    var permsInitialized = false

    var warnedNonText = false    // touched only on the inject queue

    // Tap thread bits (touched only on the tap thread once started).
    var tap: CFMachPort?
    var runLoopSource: CFRunLoopSource?
    weak var tapRunLoop: CFRunLoop?

    let injectQueue = DispatchQueue(label: "com.saysomething.helper.inject")
    let timerQueue = DispatchQueue(label: "com.saysomething.helper.timers")

    // Event source for our synthesized events (independent private state).
    let evtSource = CGEventSource(stateID: .privateState)

    let eventMask: CGEventMask =
        (CGEventMask(1) << CGEventType.keyDown.rawValue) |
        (CGEventMask(1) << CGEventType.keyUp.rawValue) |
        (CGEventMask(1) << CGEventType.flagsChanged.rawValue) |
        (CGEventMask(1) << CGEventType.leftMouseDown.rawValue) |
        (CGEventMask(1) << CGEventType.leftMouseUp.rawValue)

    // ---- Tap thread -------------------------------------------------

    func startTapThread() {
        let t = Thread { [weak self] in self?.tapThreadMain() }
        t.name = "com.saysomething.helper.tap"
        t.stackSize = 512 * 1024
        t.start()
    }

    func tapThreadMain() {
        self.tapRunLoop = CFRunLoopGetCurrent()

        // 2s poll: watchdog (re-arm a silently-disabled tap), (re)create the tap
        // once grants appear, and report perms whenever they change.
        let timer = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 2.0, 2.0, 0, 0) { [weak self] _ in
            self?.pollTick()
        }
        CFRunLoopAddTimer(CFRunLoopGetCurrent(), timer, .commonModes)

        tryCreateTap()
        CFRunLoopRun()
    }

    func removeTap() {
        if let src = self.runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), src, .commonModes)
            self.runLoopSource = nil
        }
        if let t = self.tap {
            CGEvent.tapEnable(tap: t, enable: false)
            self.tap = nil
        }
    }

    // Try .defaultTap (swallow-capable); fall back to .listenOnly; else leave the
    // tap nil and let the poll retry once Input Monitoring is granted.
    func tryCreateTap() {
        removeTap()
        // Any modifier transitions that happened while the tap was down were
        // missed; drop the tracking rather than trust it.
        stateLock.lock(); downModifierKeycodes.removeAll(); stateLock.unlock()
        if let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                     options: .defaultTap, eventsOfInterest: eventMask,
                                     callback: tapEventCallback, userInfo: nil) {
            install(t, isDefault: true)
            return
        }
        if let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                     options: .listenOnly, eventsOfInterest: eventMask,
                                     callback: tapEventCallback, userInfo: nil) {
            install(t, isDefault: false)
            return
        }
        // No tap yet (no Input Monitoring). Keep running; the poll retries.
        stateLock.lock(); tapIsDefault = false; stateLock.unlock()
    }

    func install(_ t: CFMachPort, isDefault: Bool) {
        self.tap = t
        stateLock.lock(); self.tapIsDefault = isDefault; stateLock.unlock()
        let src = CFMachPortCreateRunLoopSource(nil, t, 0)
        self.runLoopSource = src
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        emitLog("event tap active (" + (isDefault ? "default/swallow" : "listen-only") + ")")
    }

    var axUpgradeAttempted = false  // tap thread only

    func pollTick() {
        // Watchdog: a signed tap can be silently disabled — re-arm it.
        if let t = self.tap {
            if !CGEvent.tapIsEnabled(tap: t) {
                CGEvent.tapEnable(tap: t, enable: true)
            }
            // Grant-order upgrade: Input Monitoring alone yields a listen-only tap;
            // once Accessibility lands too, rebuild so the swallow-capable
            // .defaultTap takes over. One attempt per false->true AX flip (a failed
            // upgrade falls back to listen-only and must not thrash every poll).
            stateLock.lock(); let isDefault = tapIsDefault; stateLock.unlock()
            let ax = AXIsProcessTrusted()
            if !ax { axUpgradeAttempted = false }
            if !isDefault && ax && !axUpgradeAttempted {
                axUpgradeAttempted = true
                tryCreateTap()
            }
        } else if CGPreflightListenEventAccess() {
            // Grant appeared since startup — build the tap now.
            tryCreateTap()
        }
        emitPermsIfChanged()
    }

    // ---- Perms ------------------------------------------------------

    func emitPermsNow() {
        let listen = CGPreflightListenEventAccess()
        let ax = AXIsProcessTrusted()
        permsLock.lock(); lastListen = listen; lastAx = ax; permsInitialized = true; permsLock.unlock()
        emitPerms(listen, ax)
    }

    func emitPermsIfChanged() {
        let listen = CGPreflightListenEventAccess()
        let ax = AXIsProcessTrusted()
        permsLock.lock()
        let changed = !permsInitialized || listen != lastListen || ax != lastAx
        lastListen = listen; lastAx = ax; permsInitialized = true
        permsLock.unlock()
        if changed { emitPerms(listen, ax) }
    }

    // ---- Event handling (tap thread) --------------------------------

    func handleEvent(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = self.tap { CGEvent.tapEnable(tap: t, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        // Ignore our own synthesized events (paste/type/click) — never feed back.
        if event.getIntegerValueField(.eventSourceUserData) == MAGIC {
            return Unmanaged.passUnretained(event)
        }
        switch type {
        case .keyDown, .keyUp, .flagsChanged:
            return handleKey(type: type, event: event)
        case .leftMouseDown:
            return handleMouseDown(event: event)
        case .leftMouseUp:
            return handleMouseUp(event: event)
        default:
            return Unmanaged.passUnretained(event)
        }
    }

    func handleKey(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let kc = Int(event.getIntegerValueField(.keyboardEventKeycode))
        let down: Bool
        if type == .flagsChanged {
            guard let cls = modifierFlagClass(forKeycode: kc) else {
                return Unmanaged.passUnretained(event)  // caps lock / fn / etc.
            }
            // event.flags is the AGGREGATE class state after this event, so it can't
            // distinguish "this key pressed" from "this key released while a same-class
            // sibling stays held" (e.g. Right Cmd released under a held Left Cmd keeps
            // the Command flag set). Track per-keycode transitions instead: flag clear
            // means the whole class is up; flag set means a keycode we saw go down is
            // now releasing, anything else is a fresh press. Self-heals whenever the
            // class fully clears.
            stateLock.lock()
            if !event.flags.contains(cls) {
                down = false
                downModifierKeycodes = downModifierKeycodes.filter { modifierFlagClass(forKeycode: $0) != cls }
            } else if downModifierKeycodes.contains(kc) {
                down = false
                downModifierKeycodes.remove(kc)
            } else {
                down = true
                downModifierKeycodes.insert(kc)
            }
            stateLock.unlock()
        } else {
            down = (type == .keyDown)
        }
        let vk = keycodeToVK[kc] ?? -1

        stateLock.lock()
        if captureArmed {
            let res = handleCaptureKeyLocked(vk: vk, down: down)
            let swallow = tapIsDefault
            stateLock.unlock()
            if res.emit { emitCaptured(res.vk, res.mods) }
            return swallow ? nil : Unmanaged.passUnretained(event)
        }
        if watchedKeycodes.contains(kc) {
            let vks = Array(watchedVKs)
            // Swallow policy. Swallowing EVERY watched key is a trap: binding
            // Ctrl+Q puts Q and both Ctrls in the watch set, and eating them
            // unconditionally kills bare Q (and Ctrl chords) system-wide. So:
            //  - modifier keys: swallow only for pure-modifier bindings (the
            //    default Right Cmd / Right Option, where eating them is invisible);
            //    a combo's modifier halves must keep working everywhere.
            //  - Esc: only ever watched while recording; always eat the cancel.
            //  - a combo's trigger key: eat it only mid-chord (a watched modifier
            //    is physically down right now); bare presses type normally.
            //  - a bare non-modifier binding: it IS the hotkey, eat it.
            var swallow = tapIsDefault
            if swallow {
                let watchedModKeycodes = watchedKeycodes.filter { modifierFlagClass(forKeycode: $0) != nil }
                let hasNonModTrigger = watchedKeycodes.contains { modifierFlagClass(forKeycode: $0) == nil && $0 != 53 }
                if modifierFlagClass(forKeycode: kc) != nil {
                    swallow = !hasNonModTrigger
                } else if vk == 27 {
                    swallow = true
                } else if !watchedModKeycodes.isEmpty {
                    swallow = watchedModKeycodes.contains { CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) }
                }
            }
            stateLock.unlock()
            let held = snapshotHeld(vks)
            emitKey(vk, down, held)
            return swallow ? nil : Unmanaged.passUnretained(event)
        }
        stateLock.unlock()
        return Unmanaged.passUnretained(event)
    }

    // Chord capture: accumulate held modifiers, resolve on a non-modifier keydown
    // (mods + that key) or a lone modifier's release (bind the modifier itself).
    // Caller MUST hold stateLock. Mirrors the C# HandleCaptureKey().
    func handleCaptureKeyLocked(vk: Int, down: Bool) -> (emit: Bool, vk: Int, mods: [Int]) {
        guard captureArmed else { return (false, 0, []) }
        let isMod = isModifierVK(vk)
        if down {
            if isMod {
                if !captureMods.contains(vk) { captureMods.append(vk) }
                return (false, 0, [])
            }
            let mods = captureMods
            disarmCaptureLocked()
            return (true, vk, mods)
        } else {
            if !isMod { return (false, 0, []) }
            guard let idx = captureMods.firstIndex(of: vk) else { return (false, 0, []) }
            captureMods.remove(at: idx)
            let mods = captureMods
            disarmCaptureLocked()
            return (true, vk, mods)
        }
    }

    // Real-time physical state of the watched keys, via CGEventSource.keyState on
    // the combined session state (immune to key-ups missed across a lock/space
    // switch). Mirrors the C# GetAsyncKeyState snapshot.
    func snapshotHeld(_ vks: [Int]) -> [Int] {
        var held = [Int]()
        for vk in vks {
            for kc in keycodesForWatchedVK(vk) {
                if CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(kc)) {
                    held.append(vk)
                    break
                }
            }
        }
        return held
    }

    func handleMouseDown(event: CGEvent) -> Unmanaged<CGEvent>? {
        stateLock.lock()
        let armed = pickArmed
        if armed { pickArmed = false; swallowNextMouseUp = true; pickGen += 1 }
        let swallow = tapIsDefault
        stateLock.unlock()
        if armed {
            let loc = event.location  // global, top-left origin — matches Electron screen coords
            emitPicked(Int(loc.x.rounded()), Int(loc.y.rounded()))
            return swallow ? nil : Unmanaged.passUnretained(event)
        }
        return Unmanaged.passUnretained(event)
    }

    func handleMouseUp(event: CGEvent) -> Unmanaged<CGEvent>? {
        stateLock.lock()
        let sw = swallowNextMouseUp
        if sw { swallowNextMouseUp = false }
        let swallow = tapIsDefault
        stateLock.unlock()
        return (sw && swallow) ? nil : Unmanaged.passUnretained(event)
    }

    // ---- Capture / pick arming (command thread) ---------------------

    func setWatch(_ vks: [Int]) {
        var kcs = Set<Int>()
        for vk in vks { for kc in keycodesForWatchedVK(vk) { kcs.insert(kc) } }
        stateLock.lock()
        watchedVKs = Set(vks)
        watchedKeycodes = kcs
        stateLock.unlock()
    }

    func armCapture() {
        stateLock.lock()
        captureArmed = true
        captureMods.removeAll()
        captureGen += 1
        let gen = captureGen
        stateLock.unlock()
        timerQueue.asyncAfter(deadline: .now() + Double(CAPTURE_TIMEOUT_MS) / 1000.0) { [weak self] in
            guard let self = self else { return }
            self.stateLock.lock()
            if self.captureArmed && self.captureGen == gen { self.disarmCaptureLocked() }
            self.stateLock.unlock()
        }
    }

    func disarmCapture() {
        stateLock.lock(); disarmCaptureLocked(); stateLock.unlock()
    }

    // Caller MUST hold stateLock.
    func disarmCaptureLocked() {
        captureArmed = false
        captureMods.removeAll()
        captureGen += 1
    }

    func armPick() {
        stateLock.lock()
        pickArmed = true
        pickGen += 1
        let gen = pickGen
        stateLock.unlock()
        timerQueue.asyncAfter(deadline: .now() + Double(PICK_TIMEOUT_MS) / 1000.0) { [weak self] in
            guard let self = self else { return }
            self.stateLock.lock()
            if self.pickArmed && self.pickGen == gen { self.pickArmed = false }
            self.stateLock.unlock()
        }
    }

    func disarmPick() {
        stateLock.lock(); pickArmed = false; pickGen += 1; stateLock.unlock()
    }

    // ---- Injection (inject queue) -----------------------------------

    func setPasteboard(_ s: String) -> Bool {
        let pb = NSPasteboard.general
        pb.clearContents()
        if s.isEmpty { return true }
        return pb.setString(s, forType: .string)
    }

    func postCmdV() {
        if let down = CGEvent(keyboardEventSource: evtSource, virtualKey: KVK_ANSI_V, keyDown: true) {
            down.flags = .maskCommand
            down.setIntegerValueField(.eventSourceUserData, value: MAGIC)
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(keyboardEventSource: evtSource, virtualKey: KVK_ANSI_V, keyDown: false) {
            up.flags = .maskCommand
            up.setIntegerValueField(.eventSourceUserData, value: MAGIC)
            up.post(tap: .cghidEventTap)
        }
    }

    func doPaste(text: String, restoreMs: Int) {
        guard AXIsProcessTrusted() else { emitResult("pasted", "accessibility not granted"); return }
        let pb = NSPasteboard.general
        var saved: String? = nil
        if let existing = pb.string(forType: .string) {
            saved = existing
        } else if let types = pb.types, !types.isEmpty {
            // Non-text content isn't saved/restored; our text is left behind.
            if !warnedNonText {
                warnedNonText = true
                emitLog("clipboard held non-text content; leaving pasted text on the clipboard")
            }
        }
        if !setPasteboard(text) { emitResult("pasted", "could not set clipboard"); return }
        postCmdV()
        if restoreMs > 0 { usleep(useconds_t(restoreMs * 1000)) }
        if let s = saved { _ = setPasteboard(s) }
        emitResult("pasted", nil)
    }

    func doType(text: String) {
        guard AXIsProcessTrusted() else { emitResult("typed", "accessibility not granted"); return }
        if text.isEmpty { emitResult("typed", nil); return }
        let units = Array(text.utf16)
        var i = 0
        while i < units.count {
            // Newlines become a real Return keystroke — many apps ignore control
            // chars in the unicode-string path. Bare \r is skipped (\r\n collapses
            // into the \n). Mirrors the C# helper.
            if units[i] == 0x0D { i += 1; continue }
            if units[i] == 0x0A {
                postKeyPress(36)   // kVK_Return
                i += 1
                continue
            }
            // Plain-text run: <= 20 UTF-16 units per event pair, stopping before a
            // newline and never splitting a surrogate pair across chunks.
            var end = min(i + 20, units.count)
            if let nl = units[i..<end].firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) { end = nl }
            if end - i > 1 && end < units.count && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
            var chunk = Array(units[i..<end])
            if let down = CGEvent(keyboardEventSource: evtSource, virtualKey: 0, keyDown: true) {
                down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
                down.setIntegerValueField(.eventSourceUserData, value: MAGIC)
                down.post(tap: .cghidEventTap)
            }
            if let up = CGEvent(keyboardEventSource: evtSource, virtualKey: 0, keyDown: false) {
                up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
                up.setIntegerValueField(.eventSourceUserData, value: MAGIC)
                up.post(tap: .cghidEventTap)
            }
            i = end
        }
        emitResult("typed", nil)
    }

    // Synthesize a bare key press (down+up) by keycode, tagged as our own.
    func postKeyPress(_ keycode: CGKeyCode) {
        if let down = CGEvent(keyboardEventSource: evtSource, virtualKey: keycode, keyDown: true) {
            down.setIntegerValueField(.eventSourceUserData, value: MAGIC)
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(keyboardEventSource: evtSource, virtualKey: keycode, keyDown: false) {
            up.setIntegerValueField(.eventSourceUserData, value: MAGIC)
            up.post(tap: .cghidEventTap)
        }
    }

    func doCopy(text: String) {
        if setPasteboard(text) { emitResult("copied", nil) }
        else { emitResult("copied", "could not set clipboard") }
    }

    // Bring an app frontmost via the Accessibility API. NSRunningApplication's
    // activate() is a cooperative-yield protocol that needs a pumping
    // NSApplication on the CALLING side — from this CLI it silently fails and
    // can block forever inside _yieldToApplication. Setting AXFrontmost is the
    // mechanism CLI tools and window managers use instead; we already hold the
    // Accessibility grant it needs.
    func axActivate(_ pid: pid_t) {
        let app = AXUIElementCreateApplication(pid)
        let err = AXUIElementSetAttributeValue(app, "AXFrontmost" as CFString, kCFBooleanTrue)
        if err != .success {
            emitLog("placeAt: AXFrontmost set failed for pid " + String(pid) + " (AXError " + String(err.rawValue) + ")")
        }
    }

    func doPlaceAt(x: Int, y: Int, text: String, restoreMs: Int) {
        guard AXIsProcessTrusted() else { emitResult("placed", "accessibility not granted"); return }
        let pb = NSPasteboard.general
        let saved = pb.string(forType: .string)
        if !setPasteboard(text) { emitResult("placed", "could not set clipboard"); return }

        // The drop pad window is being hidden by Electron right now; give the
        // window server time to actually remove it from under the cursor, or the
        // click below lands on the pad itself instead of the drop target.
        usleep(120_000)

        let pt = CGPoint(x: Double(x), y: Double(y))

        // A click alone loses the focus race on macOS: the pad had focus, so the
        // moment it hides, AppKit re-activates another of OUR windows (Settings),
        // often AFTER the click activated the target — and the paste lands back
        // in Say Something. So don't race: find the app that owns the topmost
        // window under the drop point and activate IT by pid, wait until it is
        // genuinely frontmost, then click to place the caret, then paste.
        var targetPid: pid_t = 0
        let ownPids: Set<pid_t> = [getpid(), getppid()]  // us + the Electron main
        if let wins = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                 kCGNullWindowID) as? [[String: Any]] {
            for w in wins {
                guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
                      let pid = w[kCGWindowOwnerPID as String] as? Int,
                      !ownPids.contains(pid_t(pid)),
                      let bDict = w[kCGWindowBounds as String] as? NSDictionary,
                      let r = CGRect(dictionaryRepresentation: bDict as CFDictionary),
                      r.contains(pt) else { continue }
                targetPid = pid_t(pid)
                break
            }
        }
        emitLog("placeAt: target pid " + String(targetPid) + (targetPid == 0 ? " (none under point)" : ""))
        if targetPid != 0, NSWorkspace.shared.frontmostApplication?.processIdentifier != targetPid {
            axActivate(targetPid)
            for _ in 0..<40 {  // up to 1 s
                usleep(25_000)
                if NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid { break }
            }
            emitLog("placeAt: activation wait done, front=" + String(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1))
        }

        CGWarpMouseCursorPosition(pt)
        CGAssociateMouseAndMouseCursorPosition(1)
        usleep(10_000)
        if let down = CGEvent(mouseEventSource: evtSource, mouseType: .leftMouseDown,
                              mouseCursorPosition: pt, mouseButton: .left) {
            down.setIntegerValueField(.mouseEventClickState, value: 1)
            down.setIntegerValueField(.eventSourceUserData, value: MAGIC)
            down.post(tap: .cghidEventTap)
        }
        usleep(20_000)
        if let up = CGEvent(mouseEventSource: evtSource, mouseType: .leftMouseUp,
                            mouseCursorPosition: pt, mouseButton: .left) {
            up.setIntegerValueField(.mouseEventClickState, value: 1)
            up.setIntegerValueField(.eventSourceUserData, value: MAGIC)
            up.post(tap: .cghidEventTap)
        }
        // Re-confirm the target is still frontmost after the click (an async
        // re-activation of our own app can slip in), then settle and paste.
        for _ in 0..<20 {
            usleep(25_000)
            let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
            if targetPid != 0 {
                if front == targetPid { break }
                axActivate(targetPid)
            } else if front != nil, !ownPids.contains(front!) {
                break
            }
        }
        usleep(80_000)
        emitLog("placeAt: pasting")
        postCmdV()
        if restoreMs > 0 { usleep(useconds_t(restoreMs * 1000)) }
        if let s = saved { _ = setPasteboard(s) }
        emitResult("placed", nil)
    }

    func doForeground() {
        var exe = ""
        if let app = NSWorkspace.shared.frontmostApplication {
            exe = app.localizedName ?? app.bundleIdentifier ?? ""
        }
        emitForeground(exe, "")
    }

    // ---- Command dispatch (main/stdin thread) -----------------------

    func handleCommand(_ line: String) {
        guard let data = line.data(using: .utf8) else { return }
        let parsed = try? JSONSerialization.jsonObject(with: data, options: [])
        guard let obj = parsed as? [String: Any] else { return }   // malformed / non-object -> ignore
        guard let cmd = obj["cmd"] as? String else { return }

        switch cmd {
        case "ping":
            emitSimple("pong")

        case "watch":
            var vks = [Int]()
            if let arr = obj["vks"] as? [Any] {
                for v in arr {
                    if let n = asInt(v), n >= 0, n <= 255 { vks.append(n) }
                }
            }
            setWatch(vks)

        case "capture":
            armCapture()

        case "capture-cancel":
            disarmCapture()

        case "paste":
            let text = asString(obj["text"]) ?? ""
            var restoreMs = asInt(obj["restoreMs"]) ?? 300
            if restoreMs < 0 { restoreMs = 0 }
            injectQueue.async { [weak self] in self?.doPaste(text: text, restoreMs: restoreMs) }

        case "type":
            let text = asString(obj["text"]) ?? ""
            injectQueue.async { [weak self] in self?.doType(text: text) }

        case "clipboard":
            let text = asString(obj["text"]) ?? ""
            injectQueue.async { [weak self] in self?.doCopy(text: text) }

        case "placeAt":
            let text = asString(obj["text"]) ?? ""
            let x = asInt(obj["x"]) ?? 0
            let y = asInt(obj["y"]) ?? 0
            var restoreMs = asInt(obj["restoreMs"]) ?? 300
            if restoreMs < 0 { restoreMs = 0 }
            injectQueue.async { [weak self] in self?.doPlaceAt(x: x, y: y, text: text, restoreMs: restoreMs) }

        case "pickPoint":
            armPick()

        case "pick-cancel":
            disarmPick()

        case "foreground":
            injectQueue.async { [weak self] in self?.doForeground() }

        case "perms":
            // Synchronous (like ping) so a fresh perms reply is never lost to a
            // quit that races behind it on the inject queue.
            emitPermsNow()

        case "perms-request":
            let kind = asString(obj["kind"]) ?? ""
            injectQueue.async {
                if kind == "listen" {
                    _ = CGRequestListenEventAccess()
                } else if kind == "ax" {
                    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
                    _ = AXIsProcessTrustedWithOptions(opts)
                }
            }

        case "quit":
            if let t = self.tap { CGEvent.tapEnable(tap: t, enable: false) }
            fflush(stdout)
            exit(0)

        default:
            break   // unknown commands ignored on purpose
        }
    }
}

// Global singleton reached by the refcon-free C callback.
let gHelper = Helper()

// CGEventTap C callback — captures no context; reaches gHelper via the global.
func tapEventCallback(proxy: CGEventTapProxy, type: CGEventType,
                      event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    return gHelper.handleEvent(type: type, event: event)
}

// ===================================================================
// MARK: - main
// ===================================================================

// Bring up the tap thread (which attempts tap creation + starts the poll), then
// announce readiness regardless of grants, report perms once, and pump stdin.
gHelper.startTapThread()

emitSimple("ready")
gHelper.emitPermsNow()

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    gHelper.handleCommand(trimmed)
}

// stdin closed (parent gone) — leave cleanly.
exit(0)
