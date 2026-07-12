'use strict';

/*
 * SaySomething settings renderer (agent E).
 *
 * Plain browser JS (no modules/framework). Talks to main exclusively through the
 * preload bridge window.saysomething = { send, on, invoke } using the channels declared
 * in src/main/ipc.js. When the bridge is absent (e.g. opened outside Electron for
 * a design preview) a local fallback keeps the page interactive with demo data.
 */

(function () {
  // -------------------------------------------------------------------------
  // bridge (+ fallback for preview outside Electron)
  // -------------------------------------------------------------------------

  var api = window.saysomething || makeFallbackApi();

  var settings = null;          // latest settings snapshot
  var downloading = Object.create(null); // model name -> true while a download runs

  // -------------------------------------------------------------------------
  // small helpers
  // -------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function noop() {}

  function persist(partial) {
    try { api.invoke('settings:set', partial).catch(noop); } catch (e) { /* ignore */ }
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1700);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, function () { legacyCopy(text); });
    } else {
      legacyCopy(text);
    }
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('Copied');
    } catch (e) {
      toast('Could not copy');
    }
  }

  function fmtSize(mb) {
    if (typeof mb !== 'number' || !isFinite(mb)) return '';
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    return Math.round(mb) + ' MB';
  }

  function relTime(at) {
    var diff = Date.now() - at;
    if (diff < 0) diff = 0;
    var s = Math.floor(diff / 1000);
    if (s < 45) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7) return d + 'd ago';
    var date = new Date(at);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // guard: never overwrite a control the user is actively editing
  function focused(elm) { return document.activeElement === elm; }

  function setChecked(id, val) {
    var e = $(id);
    if (e && !focused(e)) e.checked = !!val;
  }
  function setSelectValue(id, val) {
    var e = $(id);
    if (e && !focused(e)) e.value = val;
  }
  function setRange(id, outId, val, suffix) {
    var e = $(id);
    if (e && !focused(e)) e.value = val;
    var o = $(outId);
    if (o) o.textContent = val + suffix;
  }

  // -------------------------------------------------------------------------
  // tabs
  // -------------------------------------------------------------------------

  function initTabs() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (tab) {
        tab.addEventListener('click', function () { activateTab(tab.getAttribute('data-tab')); });
      })(tabs[i]);
    }
  }

  function activateTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-tab') === name);
    }
    var pages = document.querySelectorAll('.page');
    for (var j = 0; j < pages.length; j++) {
      pages[j].classList.toggle('is-active', pages[j].id === 'tab-' + name);
    }
    // refresh live data for the section being shown
    if (name === 'model') loadModels();
    else if (name === 'history') loadHistory();
    else if (name === 'about') loadAbout();
    else if (name === 'general') refreshMics();
    else if (name === 'rewrite') loadOllamaModels();
  }

  // -------------------------------------------------------------------------
  // General
  // -------------------------------------------------------------------------

  var LANGS = [
    ['en', 'English'], ['auto', 'Auto-detect'],
    ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
    ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'],
    ['uk', 'Ukrainian'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
    ['hi', 'Hindi'], ['ar', 'Arabic'], ['tr', 'Turkish'], ['sv', 'Swedish'],
  ];

  function buildLanguageOptions() {
    var sel = $('language');
    if (!sel || sel.options.length) return;
    for (var i = 0; i < LANGS.length; i++) {
      var opt = document.createElement('option');
      opt.value = LANGS[i][0];
      opt.textContent = LANGS[i][1];
      sel.appendChild(opt);
    }
  }

  function renderGeneral() {
    if (!settings) return;
    setSelectValue('language', settings.language);

    setChecked('fmt-fillerRemoval', settings.format.fillerRemoval);
    setChecked('fmt-voiceCommands', settings.format.voiceCommands);
    setChecked('fmt-trailingSpace', settings.format.trailingSpace);
    setChecked('fmt-autoCapitalize', settings.format.autoCapitalize);
    setChecked('fmt-artifactStrip', settings.format.artifactStrip);

    setChecked('mic-warm', settings.mic.warm);
    setRange('mic-preroll', 'mic-preroll-out', settings.mic.preRollMs, ' ms');

    var mode = settings.inject.mode === 'type' ? 'type' : 'paste';
    var pasteR = $('inject-paste'); var typeR = $('inject-type');
    if (pasteR && !focused(pasteR)) pasteR.checked = (mode === 'paste');
    if (typeR && !focused(typeR)) typeR.checked = (mode === 'type');
    setRange('inject-restore', 'inject-restore-out', settings.inject.restoreClipboardMs, ' ms');

    setChecked('overlay-chime', settings.overlay.chime);
    setChecked('overlay-streaming', settings.streaming && settings.streaming.enabled);
    setRange('overlay-offset', 'overlay-offset-out', settings.overlay.offsetY, ' px');

    setChecked('launch-at-login', settings.launchAtLogin);
    setChecked('history-enabled', settings.history.enabled);
  }

  function wireGeneral() {
    $('language').addEventListener('change', function () { persist({ language: this.value }); });

    bindToggle('fmt-fillerRemoval', function (v) { persist({ format: { fillerRemoval: v } }); });
    bindToggle('fmt-voiceCommands', function (v) { persist({ format: { voiceCommands: v } }); });
    bindToggle('fmt-trailingSpace', function (v) { persist({ format: { trailingSpace: v } }); });
    bindToggle('fmt-autoCapitalize', function (v) { persist({ format: { autoCapitalize: v } }); });
    bindToggle('fmt-artifactStrip', function (v) { persist({ format: { artifactStrip: v } }); });

    bindToggle('mic-warm', function (v) { persist({ mic: { warm: v } }); });
    bindRange('mic-preroll', 'mic-preroll-out', ' ms', function (n) { persist({ mic: { preRollMs: n } }); });

    $('mic-device').addEventListener('change', function () { persist({ mic: { deviceId: this.value } }); });
    $('mic-grant').addEventListener('click', grantMic);

    var modeInputs = document.querySelectorAll('input[name="injectMode"]');
    for (var i = 0; i < modeInputs.length; i++) {
      modeInputs[i].addEventListener('change', function () {
        if (this.checked) persist({ inject: { mode: this.value } });
      });
    }
    bindRange('inject-restore', 'inject-restore-out', ' ms', function (n) { persist({ inject: { restoreClipboardMs: n } }); });

    bindToggle('overlay-chime', function (v) { persist({ overlay: { chime: v } }); });
    bindToggle('overlay-streaming', function (v) { persist({ streaming: { enabled: v } }); });
    bindRange('overlay-offset', 'overlay-offset-out', ' px', function (n) { persist({ overlay: { offsetY: n } }); });

    bindToggle('launch-at-login', function (v) { persist({ launchAtLogin: v }); });
    bindToggle('history-enabled', function (v) { persist({ history: { enabled: v } }); loadHistory(); });
  }

  function bindToggle(id, cb) {
    var e = $(id);
    if (e) e.addEventListener('change', function () { cb(this.checked); });
  }
  function bindRange(id, outId, suffix, cb) {
    var e = $(id);
    if (!e) return;
    e.addEventListener('input', function () {
      var o = $(outId);
      if (o) o.textContent = this.value + suffix;
    });
    e.addEventListener('change', function () { cb(parseInt(this.value, 10)); });
  }

  // -------------------------------------------------------------------------
  // Microphone device picker
  // -------------------------------------------------------------------------

  function refreshMics() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var sel = $('mic-device');
      if (!sel) return;
      var wanted = settings ? settings.mic.deviceId : 'default';
      var inputs = devices.filter(function (d) { return d.kind === 'audioinput'; });
      var missingLabels = false;

      sel.innerHTML = '';
      var def = document.createElement('option');
      def.value = 'default';
      def.textContent = 'System default';
      sel.appendChild(def);

      for (var i = 0; i < inputs.length; i++) {
        var d = inputs[i];
        if (d.deviceId === 'default' || d.deviceId === '') continue;
        var opt = document.createElement('option');
        opt.value = d.deviceId;
        if (d.label) {
          opt.textContent = d.label;
        } else {
          opt.textContent = 'Microphone ' + (i + 1);
          missingLabels = true;
        }
        sel.appendChild(opt);
      }

      // select the saved device if still present, else fall back to default
      var found = false;
      for (var j = 0; j < sel.options.length; j++) {
        if (sel.options[j].value === wanted) { found = true; break; }
      }
      sel.value = found ? wanted : 'default';

      var grantRow = $('mic-grant-row');
      if (grantRow) grantRow.hidden = !missingLabels;
    }).catch(function () { /* enumeration not available */ });
  }

  function grantMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Microphone unavailable');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      refreshMics();
    }).catch(function () {
      toast('Microphone access denied');
    });
  }

  // -------------------------------------------------------------------------
  // Hotkey
  // -------------------------------------------------------------------------

  function renderHotkey() {
    if (!settings) return;
    // Fallbacks only apply if a stored name is blank; keep them platform-correct.
    var name = $('hotkey-name');
    if (name) name.textContent = settings.hotkey.name || (IS_MAC ? 'Right Cmd' : 'Right Ctrl');

    var padName = $('padhotkey-name');
    if (padName) padName.textContent = (settings.padHotkey && settings.padHotkey.name) || (IS_MAC ? 'Right Option' : 'Right Alt');
    setChecked('pad-enabled', settings.pad && settings.pad.enabled);

    var a = settings.autoStop || {};
    setChecked('autostop-enabled', a.enabled);
    var ms = (typeof a.silenceMs === 'number') ? a.silenceMs : 2000;
    var sil = $('autostop-silence');
    if (sil && !focused(sil)) sil.value = ms;
    var out = $('autostop-silence-out');
    if (out) out.textContent = (ms / 1000).toFixed(1) + ' s';
  }

  // Combo hotkeys (issue #1): the capture result carries the trigger vk/name plus
  // any held modifier VKs. Normalize L/R modifiers to a generic one (so "Alt + T"
  // fires on either Alt) and build a display label. Returns { vk, name, mods }.
  // The trigger name comes from the helper (already platform-correct, e.g. "Right
  // Cmd"), but modifier labels are composed here, so mac says Option/Cmd not Alt/Win.
  var IS_MAC = /^Mac/.test(navigator.platform || '');
  var MOD_NORMALIZE = { 16: 16, 160: 16, 161: 16, 17: 17, 162: 17, 163: 17, 18: 18, 164: 18, 165: 18, 91: 91, 92: 91 };
  var MOD_LABEL = IS_MAC
    ? { 16: 'Shift', 17: 'Ctrl', 18: 'Option', 91: 'Cmd' }
    : { 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 91: 'Win' };
  var MOD_ORDER = [17, 18, 16, 91]; // Ctrl, Alt/Option, Shift, Win/Cmd

  function composeHotkey(res) {
    var vk = res.vk;
    var triggerName = res.name || ('VK ' + vk);
    var mods = [];
    var seen = {};
    var raw = (res && res.mods) || [];
    for (var i = 0; i < raw.length; i++) {
      var g = MOD_NORMALIZE[raw[i]];
      if (g == null) g = raw[i];
      if (g === vk || seen[g]) continue;
      seen[g] = true;
      mods.push(g);
    }
    mods.sort(function (a, b) {
      var ia = MOD_ORDER.indexOf(a); if (ia < 0) ia = 99;
      var ib = MOD_ORDER.indexOf(b); if (ib < 0) ib = 99;
      return ia - ib;
    });
    var parts = [];
    for (var j = 0; j < mods.length; j++) parts.push(MOD_LABEL[mods[j]] || ('VK ' + mods[j]));
    parts.push(triggerName);
    return { vk: vk, name: parts.join(' + '), mods: mods };
  }

  // Shared press-to-capture flow for a hotkey button. `apply(res)` persists it.
  function wireCapture(btnId, statusId, prompt, apply) {
    var btn = $(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      var card = btn.closest('.card');
      var status = $(statusId);
      btn.disabled = true;
      if (card) card.classList.add('capturing');
      if (status) status.textContent = prompt;
      api.invoke('hotkey:capture').then(function (res) {
        if (res && typeof res.vk === 'number') { apply(res); }
        else { toast('No key captured'); }
      }).catch(function () {
        toast('Change cancelled');
      }).then(function () {
        btn.disabled = false;
        if (card) card.classList.remove('capturing');
        if (status) status.innerHTML = '&nbsp;';
      });
    });
  }

  function wireHotkey() {
    bindToggle('autostop-enabled', function (v) { persist({ autoStop: { enabled: v } }); });
    bindToggle('pad-enabled', function (v) { persist({ pad: { enabled: v } }); });

    wireCapture('padhotkey-capture', 'padhotkey-status', 'Press a key or combo for the drop pad…', function (res) {
      var hk = composeHotkey(res);
      persist({ padHotkey: hk });
      var nm = $('padhotkey-name');
      if (nm) nm.textContent = hk.name;
      toast('Drop pad key set to ' + hk.name);
    });
    var sil = $('autostop-silence');
    if (sil) {
      sil.addEventListener('input', function () {
        var o = $('autostop-silence-out');
        if (o) o.textContent = (parseInt(this.value, 10) / 1000).toFixed(1) + ' s';
      });
      sil.addEventListener('change', function () { persist({ autoStop: { silenceMs: parseInt(this.value, 10) } }); });
    }

    var btn = $('hotkey-capture');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var card = btn.closest('.card');
      var status = $('hotkey-status');
      btn.disabled = true;
      if (card) card.classList.add('capturing');
      if (status) status.textContent = 'Press a key or combo, e.g. Alt+T…';
      api.invoke('hotkey:capture').then(function (res) {
        if (res && typeof res.vk === 'number') {
          var hk = composeHotkey(res);
          persist({ hotkey: hk });
          var nm = $('hotkey-name');
          if (nm) nm.textContent = hk.name;
          toast('Hotkey set to ' + hk.name);
        } else {
          toast('No key captured');
        }
      }).catch(function () {
        toast('Hotkey change cancelled');
      }).then(function () {
        btn.disabled = false;
        if (card) card.classList.remove('capturing');
        if (status) status.innerHTML = '&nbsp;';
      });
    });
  }

  // -------------------------------------------------------------------------
  // Model manager
  // -------------------------------------------------------------------------

  function loadModels() {
    api.invoke('models:list').then(function (list) {
      renderModels(Array.isArray(list) ? list : []);
    }).catch(function () {
      renderModels([]);
    });
  }

  function renderModels(list) {
    var wrap = $('model-list');
    if (!wrap) return;
    if (!list.length) {
      wrap.innerHTML = '<div class="empty">No models available.</div>';
      return;
    }
    wrap.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      wrap.appendChild(modelCard(list[i]));
    }
  }

  function modelCard(m) {
    var isEn = /\.en$/.test(m.name);
    var card = document.createElement('div');
    card.className = 'model-card' + (m.active ? ' active' : '') + (m.recommended ? ' recommended' : '');
    card.setAttribute('data-model', m.name);

    var main = document.createElement('div');
    main.className = 'model-main';
    main.innerHTML =
      '<span class="model-name"></span>' +
      (m.recommended ? '<span class="model-rec">Recommended</span>' : '') +
      '<span class="model-badge ' + (isEn ? 'en' : '') + '"></span>';
    main.querySelector('.model-name').textContent = m.name;
    main.querySelector('.model-badge').textContent = isEn ? 'English' : 'Multilingual';

    var meta = document.createElement('div');
    meta.className = 'model-meta';
    meta.textContent = fmtSize(m.sizeMB)
      + (m.note ? ' · ' + m.note : '')
      + (m.downloaded ? ' · downloaded' : ' · not downloaded');

    var side = document.createElement('div');
    side.className = 'model-side';

    if (downloading[m.name]) {
      var cancel = button('ghost', 'Cancel', function () {
        api.invoke('models:cancel', m.name).catch(noop);
        delete downloading[m.name];
        loadModels();
      });
      side.appendChild(cancel);
    } else if (m.downloaded) {
      if (m.active) {
        var tag = document.createElement('span');
        tag.className = 'model-active-tag';
        tag.innerHTML = '<span class="dot ok"></span>Active';
        side.appendChild(tag);
      } else {
        var label = document.createElement('label');
        label.className = 'model-radio';
        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'activeModel';
        radio.addEventListener('change', function () { setActiveModel(m.name); });
        label.appendChild(radio);
        label.appendChild(document.createTextNode('Set active'));
        side.appendChild(label);
      }
    } else {
      var dl = button('primary', 'Download', function () { startDownload(m.name); });
      side.appendChild(dl);
    }

    card.appendChild(main);
    card.appendChild(meta);
    card.appendChild(side);

    if (downloading[m.name]) card.appendChild(progressEls());
    return card;
  }

  function progressEls() {
    var frag = document.createDocumentFragment();
    var bar = document.createElement('div');
    bar.className = 'progress';
    bar.innerHTML = '<i></i>';
    var label = document.createElement('div');
    label.className = 'progress-label';
    label.textContent = 'Starting…';
    frag.appendChild(bar);
    frag.appendChild(label);
    return frag;
  }

  function button(kind, text, onClick) {
    var b = document.createElement('button');
    b.className = 'btn ' + kind;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function startDownload(name) {
    downloading[name] = true;
    api.invoke('models:download', name).catch(function (err) {
      // Cancel() clears downloading[name] before this rejection lands; the main
      // side also rejects cancelled downloads with a "cancelled" message. Either
      // signal means the user stopped it on purpose — don't cry "failed".
      var msg = String((err && err.message) || '');
      var cancelled = !downloading[name] || /cancel/i.test(msg);
      delete downloading[name];
      if (!cancelled) toast('Download failed — check your connection');
      loadModels();
    });
    loadModels(); // re-render this card into progress mode
  }

  function setActiveModel(name) {
    persist({ model: name });
    api.invoke('whisper:restart').catch(noop);
    toast('Switched to ' + name);
    setTimeout(loadModels, 200);
  }

  function onModelProgress(p) {
    if (!p || !p.name) return;
    downloading[p.name] = true;
    var card = qs('.model-card[data-model="' + p.name + '"]');
    if (!card || !qs('.progress', card)) {
      renderModels(lastModelList);
      card = qs('.model-card[data-model="' + p.name + '"]');
      if (!card) return;
    }
    var bar = qs('.progress > i', card);
    var label = qs('.progress-label', card);
    var pct = typeof p.pct === 'number' ? Math.max(0, Math.min(100, p.pct)) : 0;
    if (bar) bar.style.width = pct + '%';
    if (label) {
      var txt = Math.round(pct) + '%';
      if (p.total) txt += ' · ' + fmtSize((p.bytes || 0) / (1024 * 1024)) + ' / ' + fmtSize(p.total / (1024 * 1024));
      label.textContent = txt;
    }
    if (pct >= 100 || (p.total > 0 && p.bytes >= p.total)) {
      delete downloading[p.name];
      setTimeout(loadModels, 400);
    }
  }

  // keep the last list so a mid-download progress event can rebuild if needed
  var lastModelList = [];
  var _renderModels = renderModels;
  renderModels = function (list) { lastModelList = list; _renderModels(list); };

  // -------------------------------------------------------------------------
  // Dictionary
  // -------------------------------------------------------------------------

  function renderDictionary() {
    if (!settings) return;
    var wrap = $('dict-chips');
    if (!wrap) return;
    var words = settings.dictionary || [];
    wrap.innerHTML = '';
    if (!words.length) {
      wrap.innerHTML = '<span class="empty">No custom words yet.</span>';
      return;
    }
    for (var i = 0; i < words.length; i++) {
      (function (word) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        var text = document.createElement('span');
        text.textContent = word;
        var x = document.createElement('button');
        x.setAttribute('aria-label', 'Remove ' + word);
        x.innerHTML = '&times;';
        x.addEventListener('click', function () { removeWord(word); });
        chip.appendChild(text);
        chip.appendChild(x);
        wrap.appendChild(chip);
      })(words[i]);
    }
  }

  function addWord() {
    var input = $('dict-input');
    if (!input) return;
    var w = input.value.trim();
    if (!w) return;
    var words = (settings.dictionary || []).slice();
    var exists = words.some(function (x) { return x.toLowerCase() === w.toLowerCase(); });
    if (!exists) {
      words.push(w);
      settings.dictionary = words;
      persist({ dictionary: words });
      renderDictionary();
    }
    input.value = '';
    input.focus();
  }

  function removeWord(word) {
    var words = (settings.dictionary || []).filter(function (x) { return x !== word; });
    settings.dictionary = words;
    persist({ dictionary: words });
    renderDictionary();
  }

  function wireDictionary() {
    var add = $('dict-add');
    var input = $('dict-input');
    if (add) add.addEventListener('click', addWord);
    if (input) input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addWord(); }
    });
  }

  // -------------------------------------------------------------------------
  // Rewrite (local AI via Ollama)
  // -------------------------------------------------------------------------

  var ollamaModels = [];       // last-known list of the configured server's models
  var ollamaReachable = false; // last-known server reachability

  // Loopback-only validation for the endpoint field (mirrors the main-process
  // gate). Returns a normalized origin, or null when the URL isn't local.
  function normalizeLocalUrl(v) {
    if (typeof v !== 'string' || !v.trim()) return null;
    var u;
    try { u = new URL(v.trim()); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    var h = u.hostname.toLowerCase();
    if (h.charAt(0) === '[' && h.charAt(h.length - 1) === ']') h = h.slice(1, -1);
    var loopback = (h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h));
    if (!loopback) return null;
    return u.protocol + '//' + u.host;
  }

  function renderRewrite() {
    if (!settings) return;
    var rw = settings.rewrite || {};
    setChecked('rewrite-enabled', rw.enabled);
    setSelectValue('rewrite-style', rw.style || 'cleanup');
    setSelectValue('rewrite-api', rw.api || 'ollama');
    var ep = $('rewrite-endpoint');
    if (ep && !focused(ep)) ep.value = rw.endpoint || 'http://127.0.0.1:11434';
    // The model <select> is populated live from the configured server; if we
    // already have the list, make sure the saved model is shown/selected.
    populateOllamaSelect();
  }

  function wireRewrite() {
    bindToggle('rewrite-enabled', function (v) { persist({ rewrite: { enabled: v } }); });

    var style = $('rewrite-style');
    if (style) style.addEventListener('change', function () { persist({ rewrite: { style: this.value } }); });

    var apiSel = $('rewrite-api');
    if (apiSel) apiSel.addEventListener('change', function () {
      persist({ rewrite: { api: this.value } });
      loadOllamaModels(true);
    });

    var ep = $('rewrite-endpoint');
    if (ep) ep.addEventListener('change', function () {
      var norm = normalizeLocalUrl(this.value);
      if (!norm) {
        toast('Only a local address is allowed (localhost / 127.0.0.1)');
        this.value = (settings && settings.rewrite && settings.rewrite.endpoint) || 'http://127.0.0.1:11434';
        return;
      }
      this.value = norm;
      persist({ rewrite: { endpoint: norm } });
      loadOllamaModels(true);
    });

    var model = $('rewrite-model');
    if (model) model.addEventListener('change', function () {
      if (this.value) persist({ rewrite: { model: this.value } });
    });

    var refresh = $('rewrite-refresh');
    if (refresh) refresh.addEventListener('click', function () { loadOllamaModels(true); });
  }

  function setRewriteStatus(text, kind) {
    var el = $('rewrite-status');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('rewrite-warn', 'rewrite-ok');
    if (kind) el.classList.add(kind);
  }

  function loadOllamaModels(userInitiated) {
    var serverApi = ($('rewrite-api') && $('rewrite-api').value) ||
      (settings && settings.rewrite && settings.rewrite.api) || 'ollama';
    var endpoint = ($('rewrite-endpoint') && $('rewrite-endpoint').value) ||
      (settings && settings.rewrite && settings.rewrite.endpoint) || '';
    setRewriteStatus('Checking ' + (serverApi === 'openai' ? 'the server' : 'Ollama') + '…', null);
    api.invoke('rewrite:models', { endpoint: endpoint, api: serverApi }).then(function (res) {
      res = res || {};
      ollamaReachable = !!res.reachable;
      ollamaModels = Array.isArray(res.models) ? res.models : [];
      populateOllamaSelect();
      if (!ollamaReachable) {
        if (serverApi === 'openai') {
          setRewriteStatus('No server reachable there. Start your local model server, then hit Refresh.', 'rewrite-warn');
        } else {
          setRewriteStatus('Ollama not detected — install from ollama.com, it’s free and local.', 'rewrite-warn');
        }
      } else if (!ollamaModels.length) {
        setRewriteStatus('Server is running but has no models loaded.', 'rewrite-warn');
      } else {
        setRewriteStatus(ollamaModels.length + ' model' + (ollamaModels.length === 1 ? '' : 's') + ' available on this machine.', 'rewrite-ok');
      }
    }).catch(function () {
      ollamaReachable = false;
      ollamaModels = [];
      populateOllamaSelect();
      setRewriteStatus('Could not reach the model server. Check the address and try Refresh.', 'rewrite-warn');
    });
  }

  function populateOllamaSelect() {
    var sel = $('rewrite-model');
    if (!sel || focused(sel)) return;
    var saved = (settings && settings.rewrite && settings.rewrite.model) || '';
    sel.innerHTML = '';

    if (!ollamaModels.length) {
      var opt = document.createElement('option');
      opt.value = saved || '';
      opt.textContent = saved ? (saved + ' (not installed)') : 'No models found';
      sel.appendChild(opt);
      sel.value = opt.value;
      return;
    }

    var hasSaved = saved && ollamaModels.indexOf(saved) !== -1;
    if (saved && !hasSaved) {
      // Keep the saved-but-missing model visible so the user isn't silently switched.
      var miss = document.createElement('option');
      miss.value = saved;
      miss.textContent = saved + ' (not installed)';
      sel.appendChild(miss);
    }
    for (var i = 0; i < ollamaModels.length; i++) {
      var o = document.createElement('option');
      o.value = ollamaModels[i];
      o.textContent = ollamaModels[i];
      sel.appendChild(o);
    }
    sel.value = saved || ollamaModels[0];
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  function loadHistory() {
    api.invoke('history:list').then(function (items) {
      renderHistory(Array.isArray(items) ? items : []);
    }).catch(function () { renderHistory([]); });
  }

  function renderHistory(items) {
    var wrap = $('history-list');
    if (!wrap) return;
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">No transcriptions yet.</div>';
      return;
    }
    wrap.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      wrap.appendChild(historyRow(items[i]));
    }
  }

  function historyRow(item) {
    var row = document.createElement('div');
    row.className = 'history-item';
    row.title = 'Click to copy';

    var text = document.createElement('div');
    text.className = 'history-text';
    text.textContent = item.text;

    var meta = document.createElement('div');
    meta.className = 'history-meta';
    var when = relTime(item.at);
    meta.textContent = item.app ? (when + ' · ' + item.app) : when;

    var del = document.createElement('button');
    del.className = 'history-del';
    del.setAttribute('aria-label', 'Delete');
    del.innerHTML = '&times;';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      api.invoke('history:remove', item.id).catch(noop);
      loadHistory();
    });

    row.addEventListener('click', function () { copyText(item.text); });
    row.appendChild(text);
    row.appendChild(meta);
    row.appendChild(del);
    return row;
  }

  function wireHistoryControls() {
    var clear = $('history-clear');
    if (clear) clear.addEventListener('click', function () {
      api.invoke('history:clear').catch(noop);
      loadHistory();
    });
  }

  // -------------------------------------------------------------------------
  // About / status
  // -------------------------------------------------------------------------

  function loadAbout() {
    api.invoke('app:info').then(function (info) {
      if (!info) return;
      var v = $('about-version');
      if (v && info.version) v.textContent = info.version;
      renderWhisperStatus(info.whisper || {});
      renderHelperStatus(info.helper || {});
    }).catch(noop);
  }

  function renderWhisperStatus(w) {
    var box = $('about-whisper');
    if (box) {
      var dot = qs('.dot', box);
      var txt = box.querySelector('span:last-child');
      if (dot) dot.className = 'dot ' + (w.running ? 'ok' : 'bad');
      if (txt) txt.textContent = w.running ? 'running' : 'stopped';
    }
    var detail = $('about-whisper-detail');
    if (detail) {
      detail.textContent = (w.model ? ('model ' + w.model) : '') + (w.port ? ('  ·  port ' + w.port) : '');
    }
    var rd = $('rail-status-dot');
    var rt = $('rail-status-text');
    if (rd) rd.className = 'dot ' + (w.running ? 'ok' : '');
    if (rt) rt.textContent = w.running ? 'on-device · ready' : 'on-device · private';
  }

  function renderHelperStatus(h) {
    var box = $('about-helper');
    if (!box) return;
    var dot = qs('.dot', box);
    var txt = box.querySelector('span:last-child');
    if (dot) dot.className = 'dot ' + (h.running ? 'ok' : 'bad');
    if (txt) txt.textContent = h.running ? 'running' : 'stopped';
  }

  function wireAbout() {
    var btn = $('about-restart');
    if (btn) btn.addEventListener('click', function () {
      btn.disabled = true;
      api.invoke('whisper:restart').then(function () { toast('Restarting engine…'); }, noop)
        .then(function () { setTimeout(function () { btn.disabled = false; loadAbout(); }, 800); });
    });
  }

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  function applySnapshot(s) {
    if (!s) return;
    settings = s;
    renderGeneral();
    renderHotkey();
    renderDictionary();
    renderRewrite();
  }

  function init() {
    buildLanguageOptions();
    initTabs();
    wireGeneral();
    wireHotkey();
    wireDictionary();
    wireRewrite();
    wireHistoryControls();
    wireAbout();

    api.invoke('settings:get').then(function (s) {
      applySnapshot(s);
      refreshMics();
      loadModels();
    }).catch(function () {
      // still render an empty shell
    });

    // live events from main
    api.on('settings:changed', function (p) { if (p && p.settings) applySnapshot(p.settings); });
    api.on('whisper:status', function (s) { if (s) renderWhisperStatus(s); });
    api.on('models:progress', function (p) { onModelProgress(p); });

    if (navigator.mediaDevices) {
      try { navigator.mediaDevices.addEventListener('devicechange', refreshMics); } catch (e) { /* older */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // -------------------------------------------------------------------------
  // fallback bridge (preview outside Electron)
  // -------------------------------------------------------------------------

  function makeFallbackApi() {
    var cur = {
      hotkey: { vk: 163, name: 'Right Ctrl' },
      padHotkey: { vk: 165, name: 'Right Alt' },
      pad: { enabled: true },
      mic: { deviceId: 'default', warm: true, preRollMs: 800 },
      model: 'small.en', language: 'en',
      format: { fillerRemoval: true, voiceCommands: true, trailingSpace: true, autoCapitalize: true, artifactStrip: true },
      dictionary: ['Kubernetes', 'PostgreSQL'],
      rewrite: { enabled: false, style: 'cleanup', model: '', timeoutMs: 10000 },
      inject: { mode: 'paste', restoreClipboardMs: 300 },
      streaming: { enabled: true },
      autoStop: { enabled: true, silenceMs: 2000 },
      overlay: { chime: true, offsetY: 48 },
      history: { enabled: true, max: 200 },
      launchAtLogin: false, paused: false, whisperPort: 8737, maxUtteranceSec: 300,
    };
    function merge(base, part) {
      for (var k in part) {
        if (part[k] && typeof part[k] === 'object' && !Array.isArray(part[k])) merge(base[k] || (base[k] = {}), part[k]);
        else base[k] = part[k];
      }
      return base;
    }
    var models = [
      { name: 'tiny.en', sizeMB: 75, downloaded: true, active: false },
      { name: 'base.en', sizeMB: 142, downloaded: false, active: false },
      { name: 'small.en', sizeMB: 466, downloaded: true, active: true },
      { name: 'medium.en', sizeMB: 1500, downloaded: false, active: false },
      { name: 'large-v3-turbo', sizeMB: 1620, downloaded: false, active: false },
    ];
    var history = [
      { id: 'a', text: 'Ship the aurora overlay by Friday.', ms: 640, app: 'notepad.exe', at: Date.now() - 40000 },
      { id: 'b', text: 'Remember to buy oat milk and coffee.', ms: 720, app: 'chrome.exe', at: Date.now() - 3600000 },
    ];
    return {
      send: noop,
      on: function () { return noop; },
      invoke: function (ch, payload) {
        switch (ch) {
          case 'settings:get': return Promise.resolve(JSON.parse(JSON.stringify(cur)));
          case 'settings:set': merge(cur, payload || {}); return Promise.resolve(JSON.parse(JSON.stringify(cur)));
          case 'models:list': return Promise.resolve(models);
          case 'history:list': return Promise.resolve(history);
          case 'app:info': return Promise.resolve({ version: '0.1.0', whisper: { running: true, model: cur.model, port: 8737 }, helper: { running: true } });
          case 'hotkey:capture': return Promise.resolve({ vk: 112, name: 'F1' });
          case 'rewrite:models': return Promise.resolve({ reachable: true, models: ['llama3.2:latest', 'mistral:latest', 'qwen2.5:7b'], host: 'http://127.0.0.1:11434' });
          default: return Promise.resolve(null);
        }
      },
    };
  }
})();
