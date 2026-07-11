'use strict';

/**
 * Pure, unit-testable text formatter for whisper transcripts.
 *
 * `format(text, formatSettings, rewrite)` runs a fixed pipeline, each step
 * gated by its own `format.*` toggle (see docs/CONTRACTS.md settings schema).
 * Returns '' when nothing intelligible remains ("nothing heard").
 *
 * Pipeline order (docs/SPEC.md):
 *   1. strip whisper artifacts  (format.artifactStrip)
 *   2. trim                     (always)
 *   3. voice commands           (format.voiceCommands)   "new line"/"new paragraph"
 *   4. filler removal           (format.fillerRemoval)   um / uh / erm / uhm / ahem
 *   5. collapse whitespace      (always)
 *   6. LLM-rewrite extension    (optional hook, no-op by default)
 *   7. empty check              -> '' if nothing left
 *   8. auto-capitalize          (format.autoCapitalize)  first alphabetical char
 *   9. trailing space           (format.trailingSpace)   append ' ' unless it ends in whitespace
 *
 * The function is pure (no I/O, no globals) so it can be exercised directly by
 * test/formatter-test.js.
 */

// Whisper non-speech artifact vocabulary. Conservative: bracketed tokens are
// stripped wholesale (real dictation almost never contains '['), but
// parenthesised / asterisked spans are only stripped when they name a known
// non-speech event, so legitimate parentheses survive.
var NONSPEECH_WORDS =
  'silence|music|applause|laughter|laughs?|laughing|inaudible|noise|' +
  'blank[_ ]?audio|coughs?|coughing|sighs?|breathing|clears? throat|' +
  'beep|static|wind|footsteps|clicking|typing';

var ARTIFACT_PATTERNS = [
  /\[[^\]]*\]/g, // [BLANK_AUDIO], [Music], [inaudible], [ Silence ], ...
  new RegExp('\\([^)]*\\b(?:' + NONSPEECH_WORDS + ')\\b[^)]*\\)', 'gi'), // (silence), (soft music)
  new RegExp('\\*[^*]*\\b(?:' + NONSPEECH_WORDS + ')\\b[^*]*\\*', 'gi'), // *laughs*, *music*
  /[♩♪♫♬♭♮♯]/g, // music note glyphs
];

// Filler words: exactly the SPEC set. Matched as standalone tokens, with a
// following comma and surrounding spaces consumed for a clean result.
var FILLER_RE = /[ \t]*\b(?:um+|uh+|erm|uhm|ahem)\b[ \t]*,?/gi;

var FORMAT_KEYS = [
  'artifactStrip',
  'voiceCommands',
  'fillerRemoval',
  'autoCapitalize',
  'trailingSpace',
];

/**
 * Normalize the format settings: a key is OFF only when explicitly `false`,
 * otherwise ON. So `undefined`/`{}` means "all transforms enabled".
 * @param {object} [fmt]
 * @returns {{artifactStrip:boolean,voiceCommands:boolean,fillerRemoval:boolean,autoCapitalize:boolean,trailingSpace:boolean}}
 */
function normalize(fmt) {
  var out = {};
  for (var i = 0; i < FORMAT_KEYS.length; i++) {
    var k = FORMAT_KEYS[i];
    out[k] = !(fmt && fmt[k] === false);
  }
  return out;
}

function stripArtifacts(s) {
  for (var i = 0; i < ARTIFACT_PATTERNS.length; i++) {
    s = s.replace(ARTIFACT_PATTERNS[i], ' ');
  }
  return s;
}

// Replace spoken layout commands with newlines, consuming surrounding spaces and
// a trailing sentence-punctuation mark (the command *is* the boundary). Leading
// punctuation is preserved: "First item. New line second" -> "First item.\nsecond".
function applyVoiceCommands(s) {
  s = s.replace(/[ \t]*\bnew\s+paragraph\b[ \t]*[,.;:!?]?[ \t]*/gi, '\n\n');
  s = s.replace(/[ \t]*\bnew\s+line\b[ \t]*[,.;:!?]?[ \t]*/gi, '\n');
  return s;
}

function removeFillers(s) {
  s = s.replace(FILLER_RE, ' ');
  // Clean up debris: space before punctuation, a stranded leading comma
  // ("uh, hello" -> " , hello" -> "hello"), and duplicated commas.
  s = s.replace(/[ \t]+([,.;:!?])/g, '$1');
  s = s.replace(/^[ \t]*,[ \t]*/, '');
  s = s.replace(/,(?:[ \t]*,)+/g, ',');
  return s;
}

// Collapse runs of spaces/tabs, tidy whitespace around newlines, and cap blank
// lines at one. Newlines produced by voice commands are preserved.
function collapseWhitespace(s) {
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/[ \t]*\n[ \t]*/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

// Trim leading whitespace fully; trim only trailing spaces/tabs so an intentional
// trailing newline (from a mid-text "new line") is kept.
function edgeTrim(s) {
  return s.replace(/^\s+/, '').replace(/[ \t]+$/, '');
}

function capitalizeFirst(s) {
  return s.replace(/\p{L}/u, function (c) { return c.toUpperCase(); });
}

/**
 * @param {string} text raw transcript from whisper
 * @param {object} [formatSettings] the `format` block of settings
 * @param {(cleaned:string, opts:object)=>string} [rewrite]
 *        OPTIONAL extension point for a future local LLM rewrite pass. It is a
 *        documented NO-OP in v1: the app passes no rewrite function, so this
 *        hook does nothing. When supplied it receives the deterministically
 *        cleaned text and must return a string; a thrown error or a non-string
 *        return is ignored so a misbehaving rewriter can never break dictation.
 * @returns {string} formatted text ('' means nothing intelligible was heard)
 */
function format(text, formatSettings, rewrite) {
  if (typeof text !== 'string') return '';
  var opt = normalize(formatSettings);
  var s = text;

  if (opt.artifactStrip) s = stripArtifacts(s);
  s = s.trim();
  if (opt.voiceCommands) s = applyVoiceCommands(s);
  if (opt.fillerRemoval) s = removeFillers(s);
  s = collapseWhitespace(s);
  s = edgeTrim(s);

  // Extension point (no-op by default). See @param rewrite above.
  if (typeof rewrite === 'function') {
    try {
      var rewritten = rewrite(s, opt);
      if (typeof rewritten === 'string') s = edgeTrim(rewritten);
    } catch (e) {
      // A broken rewriter must never break dictation — keep the cleaned text.
    }
  }

  if (!s) return '';

  if (opt.autoCapitalize) s = capitalizeFirst(s);
  if (opt.trailingSpace && !/\s$/.test(s)) s += ' ';

  return s;
}

/**
 * Light formatter for LIVE partial previews (display-only, never injected).
 * Deliberately does LESS than format(): strip artifacts, collapse whitespace to a
 * single line, trim, capitalize the first letter. It does NOT remove fillers,
 * apply voice-command newlines, or append a trailing space — a preview should
 * track what whisper currently hears with minimal churn, not pre-empt the final
 * authoritative pass. Newlines are flattened to spaces so it stays one line.
 * @param {string} text raw interim transcript
 * @returns {string} '' when nothing intelligible yet
 */
function formatPartial(text) {
  if (typeof text !== 'string') return '';
  var s = stripArtifacts(text);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return capitalizeFirst(s);
}

module.exports = {
  format: format,
  formatPartial: formatPartial,
  // Exposed for focused testing / reuse; not part of the integration contract.
  _internals: {
    normalize: normalize,
    stripArtifacts: stripArtifacts,
    applyVoiceCommands: applyVoiceCommands,
    removeFillers: removeFillers,
    collapseWhitespace: collapseWhitespace,
    capitalizeFirst: capitalizeFirst,
  },
};
