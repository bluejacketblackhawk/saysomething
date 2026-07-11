'use strict';

/**
 * Plain-node unit tests for src/main/whisper/formatter.js.
 * Run: `node test/formatter-test.js` — exits non-zero on the first failing block.
 * No framework, no deps.
 */

const assert = require('assert');
const { format, formatPartial } = require('../src/main/whisper/formatter');

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  try {
    assert.strictEqual(actual, expected);
    passed++;
  } catch (e) {
    failed++;
    console.error('FAIL: ' + label);
    console.error('  expected: ' + JSON.stringify(expected));
    console.error('  actual:   ' + JSON.stringify(actual));
  }
}

// ---- artifact stripping ------------------------------------------------------
eq(format('[BLANK_AUDIO]'), '', 'artifact: pure [BLANK_AUDIO] -> empty');
eq(format('Hello [Music] world'), 'Hello world ', 'artifact: [Music] removed, spaces collapsed');
eq(format('(silence)'), '', 'artifact: (silence) removed -> empty');
eq(format('[ Silence ]'), '', 'artifact: [ Silence ] bracket removed -> empty');
eq(format('do re mi ♪'), 'Do re mi ', 'artifact: music glyph stripped');
eq(format('(soft music) hello'), 'Hello ', 'artifact: parenthesised non-speech removed');
eq(format('I said (hello) to her', { trailingSpace: false }),
   'I said (hello) to her', 'artifact: legit parentheses are preserved');
eq(format('[Music] hi', { artifactStrip: false, trailingSpace: false }),
   '[Music] hi', 'artifact: toggle off keeps brackets');

// ---- filler removal ----------------------------------------------------------
eq(format('um, hello'), 'Hello ', 'filler: leading "um," removed');
eq(format('Uh, okay'), 'Okay ', 'filler: capitalized "Uh," removed (case-insensitive)');
eq(format('I uh think uh so'), 'I think so ', 'filler: interior "uh" removed twice');
eq(format('well, um, yes'), 'Well, yes ', 'filler: stranded comma cleaned up');
eq(format('ummmm hello'), 'Hello ', 'filler: elongated "ummmm" removed');
eq(format('the umbrella is uhuge', { trailingSpace: false }),
   'The umbrella is uhuge', 'filler: conservative — does not eat real words');
eq(format('um hello', { fillerRemoval: false, trailingSpace: false }),
   'Um hello', 'filler: toggle off keeps fillers');

// ---- voice commands ----------------------------------------------------------
eq(format('first item new line second item'),
   'First item\nsecond item ', 'voice: "new line" -> \\n');
eq(format('part one new paragraph part two'),
   'Part one\n\npart two ', 'voice: "new paragraph" -> \\n\\n');
eq(format('hello new paragraph'),
   'Hello\n\n', 'voice: trailing "new paragraph" keeps \\n\\n, no trailing space');
eq(format('one. New line two'),
   'One.\ntwo ', 'voice: command consumes its own spacing, keeps prior punctuation');
eq(format('new line'), '', 'voice: a lone "new line" -> empty (nothing intelligible)');
eq(format('a new line b', { voiceCommands: false, trailingSpace: false }),
   'A new line b', 'voice: toggle off leaves the words');

// ---- capitalization ----------------------------------------------------------
eq(format('hello'), 'Hello ', 'cap: first letter uppercased');
eq(format('- hello', { trailingSpace: false }), '- Hello',
   'cap: capitalizes first LETTER, skipping leading punctuation');
eq(format('hello world', { autoCapitalize: false, trailingSpace: false }),
   'hello world', 'cap: toggle off leaves case as-is');

// ---- trailing space ----------------------------------------------------------
eq(format('hello world', { trailingSpace: false }), 'Hello world',
   'trailing: toggle off -> no trailing space');
eq(format('hello world'), 'Hello world ', 'trailing: default appends one space');

// ---- empty / nothing-heard ---------------------------------------------------
eq(format(''), '', 'empty: empty string');
eq(format('    '), '', 'empty: whitespace-only');
eq(format(null), '', 'empty: null -> empty');
eq(format(undefined), '', 'empty: undefined -> empty');
eq(format(12345), '', 'empty: non-string -> empty');
eq(format('  [inaudible]  '), '', 'empty: only an artifact -> empty');

// ---- extension point (LLM rewrite hook) -------------------------------------
eq(format('hello', {}), 'Hello ', 'ext: absent hook is a no-op');
eq(format('hello', {}, function (s) { return s.toUpperCase(); }), 'HELLO ',
   'ext: supplied hook rewrites cleaned text');
eq(format('hello', {}, function () { throw new Error('boom'); }), 'Hello ',
   'ext: a throwing hook never breaks formatting');
eq(format('hello', {}, function () { return 42; }), 'Hello ',
   'ext: non-string hook return is ignored');

// ---- combined pipeline -------------------------------------------------------
eq(format('um, [BLANK_AUDIO] first line. New line uh second line'),
   'First line.\nsecond line ',
   'combined: artifact + fillers + voice command + cap + trailing space');

// ---- formatPartial (live preview: light clean, no filler/trailing/newline) --
eq(formatPartial('hello world'), 'Hello world', 'partial: capitalized, NO trailing space');
eq(formatPartial('  the quick  brown   fox '), 'The quick brown fox', 'partial: collapses to single line');
eq(formatPartial('[BLANK_AUDIO]'), '', 'partial: pure artifact -> empty');
eq(formatPartial('hello [Music] there'), 'Hello there', 'partial: artifacts stripped');
eq(formatPartial('um so I think'), 'Um so I think', 'partial: fillers KEPT (previews track raw speech)');
eq(formatPartial('one new line two'), 'One new line two', 'partial: no voice-command newlines (stays one line)');
eq(formatPartial('line one\nline two'), 'Line one line two', 'partial: existing newlines flattened to spaces');
eq(formatPartial(''), '', 'partial: empty -> empty');
eq(formatPartial(null), '', 'partial: null -> empty');
eq(formatPartial(42), '', 'partial: non-string -> empty');

// ---- summary -----------------------------------------------------------------
console.log('formatter-test: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
process.exit(0);
