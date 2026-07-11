'use strict';

/**
 * Plain-node unit tests for the PURE response sanitiser in
 * src/main/whisper/rewrite.js (the local-Ollama AI-rewrite stage).
 *
 * Run: `node test/rewrite-test.js` — exits non-zero on any failing block.
 * No framework, no deps. Mirrors the style of test/formatter-test.js.
 *
 * We test only the pure `sanitize(raw, original)` function (and a couple of its
 * internals): stripping markdown fences / wrapping quotes / conversational
 * preamble, and rejecting empty / non-string / wildly-oversized output. The
 * network path is deliberately NOT exercised here (no daemon in CI).
 */

const assert = require('assert');
const rewrite = require('../src/main/whisper/rewrite');
const { sanitize } = rewrite;

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

// text() -> the cleaned string (or null); reason() -> the machine tag.
function text(raw, original) { return sanitize(raw, original).text; }
function reason(raw, original) { return sanitize(raw, original).reason; }

// ---- passthrough -------------------------------------------------------------
eq(text('Just clean text.'), 'Just clean text.', 'passthrough: plain text unchanged');
eq(reason('Just clean text.'), 'ok', 'passthrough: reason ok');
eq(text('  padded text  '), 'padded text', 'passthrough: outer whitespace trimmed');

// ---- markdown code fences ----------------------------------------------------
eq(text('```\nhello world\n```'), 'hello world', 'fence: bare ``` block unwrapped');
eq(text('```text\nhello world\n```'), 'hello world', 'fence: ```text language tag unwrapped');
eq(text('```markdown\n- one\n- two\n```'), '- one\n- two', 'fence: multi-line block unwrapped, inner newlines kept');
eq(text('```\nonly opening fence\n'), 'only opening fence', 'fence: stray opening fence removed');

// ---- wrapping quotes ---------------------------------------------------------
eq(text('"quoted answer"'), 'quoted answer', 'quotes: straight double quotes stripped');
eq(text("'quoted answer'"), 'quoted answer', 'quotes: straight single quotes stripped');
eq(text('“smart quoted”'), 'smart quoted', 'quotes: smart double quotes stripped');
eq(text('`code span`'), 'code span', 'quotes: backticks stripped');
// A clean nested wrap (fence around quotes) strips fully; but identical quote
// chars nested (`""x""`) are left alone — the conservative interior-clean rule
// refuses so genuine `"a" and "b"` interiors are never mangled.
eq(text('""double wrapped""'), '""double wrapped""', 'quotes: ambiguous double-wrap left intact (safe)');
// Interior quotes must survive — only whole-string wrapping is stripped.
eq(text('She said "hi" to me'), 'She said "hi" to me', 'quotes: interior quotes preserved');
eq(text('"He said "go" now"'), '"He said "go" now"', 'quotes: unbalanced interior quote is not mangled');

// ---- conversational preamble -------------------------------------------------
eq(text('Sure! Here is the rewritten text: Buy milk.'), 'Buy milk.', 'preamble: "Sure! Here is ...:" stripped');
eq(text("Here's the cleaned-up version: Ship it Friday."), 'Ship it Friday.', 'preamble: "Here\'s the cleaned-up version:" stripped');
eq(text('Rewritten text: Hello there.'), 'Hello there.', 'preamble: bare "Rewritten text:" label stripped');
eq(text('Certainly, here you go: Done.'), 'Done.', 'preamble: "Certainly, here you go:" stripped');
// A legitimate colon sentence must NOT be treated as preamble.
eq(text('Note: bring your badge tomorrow.'), 'Note: bring your badge tomorrow.', 'preamble: ordinary "Note:" sentence preserved');

// ---- combined defensive cleanup ---------------------------------------------
eq(text('Here is the result:\n```\n"Final answer."\n```'), 'Final answer.',
   'combined: preamble + fence + quotes all stripped');

// ---- empty / garbage rejection ----------------------------------------------
eq(text(''), null, 'reject: empty string -> null');
eq(reason(''), 'empty', 'reject: empty reason');
eq(text('   '), null, 'reject: whitespace-only -> null');
eq(text('```\n\n```'), null, 'reject: empty fenced block -> null');
eq(text('""'), null, 'reject: empty quotes -> null');
eq(text(null), null, 'reject: null -> null');
eq(reason(null), 'non-string', 'reject: null reason non-string');
eq(text(undefined), null, 'reject: undefined -> null');
eq(text(42), null, 'reject: non-string number -> null');

// ---- oversized rejection (> 4x input) ---------------------------------------
var small = 'Buy milk.';
var huge = new Array(200).join('blah blah '); // way more than 4x
eq(text(huge, small), null, 'oversized: >4x input rejected -> null');
eq(reason(huge, small), 'oversized', 'oversized: reason');
// Moderate growth (well under the 4x ceiling) is accepted.
eq(sanitize('Please buy some milk today.', 'buy milk today').reason, 'ok',
   'oversized: moderate growth accepted');
// No `original` given -> size guard is skipped (still cleaned).
eq(reason(huge), 'ok', 'oversized: guard skipped when no original supplied');

// ---- reasoning <think> blocks (finding #1) ----------------------------------
// Well-formed <think>…</think> pair is removed; the real content survives.
eq(text('<think>The user wants concise text.</think>We ship Friday.'), 'We ship Friday.',
   'think: matched block stripped, content preserved');
eq(text('<think>\nlong reasoning\nmore reasoning\n</think>\nBuy milk.'), 'Buy milk.',
   'think: multi-line block stripped');
eq(text('<THINK>reasoning</THINK>Hello there.'), 'Hello there.',
   'think: case-insensitive tags');
// "missing-open" variant: output starts with reasoning, has only a lone </think>.
eq(text('Okay, the user wants this shorter.</think>We ship Friday.'), 'We ship Friday.',
   'think: lone </think> — keep text after it');
// "missing-close" variant: <think> opens, never closes, reasoning ends at a
// blank line before the real answer.
eq(text('<think>\nreasoning that never closes\n\nWe ship Friday.'), 'We ship Friday.',
   'think: unclosed <think> — dropped to blank-line boundary');
// Unclosed <think> that runs to end-of-string leaves nothing → discard.
eq(text('<think>reasoning all the way to the end with no answer'), null,
   'think: unclosed block to EOF -> null');
eq(reason('<think>reasoning all the way to the end with no answer'), 'empty',
   'think: unclosed-to-EOF reason empty');
// Think-only output (nothing after the block) → empty discard.
eq(text('<think>just reasoning, no answer</think>'), null,
   'think: think-only -> null');
eq(reason('<think>just reasoning, no answer</think>'), 'empty',
   'think: think-only reason empty');
// A think block wrapping the answer combined with a preamble still cleans up.
eq(text('<think>reason</think>Here is the rewritten text: Buy milk.'), 'Buy milk.',
   'think: block + preamble both stripped');

// ---- message.thinking field is ignored (finding #1) -------------------------
var extractContent = rewrite._internals.extractContent;
eq(extractContent({ message: { content: 'Buy milk.', thinking: 'secret reasoning' } }), 'Buy milk.',
   'thinking: content returned, thinking ignored');
eq(extractContent({ message: { thinking: 'secret reasoning' } }), '',
   'thinking: no content -> empty (thinking never injected)');

// ---- preamble over-strip fix (finding #2) -----------------------------------
// A legitimate colon opening that a rewrite could produce must pass UNCHANGED.
eq(text("Here's the deal: we ship Friday."), "Here's the deal: we ship Friday.",
   'preamble: "Here\'s the deal:" preserved (not meta)');
eq(text('Here is my summary: buy milk'), 'Here is my summary: buy milk',
   'preamble: "Here is my summary:" preserved (bare summary is not meta)');
// A genuine rewrite preamble must still strip.
eq(text('Here\'s the rewritten text: We ship Friday.'), 'We ship Friday.',
   'preamble: "Here\'s the rewritten text:" still stripped');

// ---- trailing model explanation (finding #3) --------------------------------
eq(text('We ship Friday.\n\nI made the sentence more concise.'), 'We ship Friday.',
   'trailing: meta explanation paragraph stripped');
eq(text('Buy milk.\n\nNote: I fixed the grammar.'), 'Buy milk.',
   'trailing: "Note:" explanation stripped');
// A final paragraph that is legitimate content must be KEPT.
eq(text('We ship Friday.\n\nWe also ship Monday.'), 'We ship Friday.\n\nWe also ship Monday.',
   'trailing: legit final paragraph kept');
eq(text('I made a promise to call you.'), 'I made a promise to call you.',
   'trailing: no blank-line boundary -> single paragraph kept even if it opens with a meta word');

// ---- internals ---------------------------------------------------------------
eq(rewrite._internals.clampTimeout(999999), rewrite.HARD_TIMEOUT_MS, 'clamp: over-cap timeout clamped to hard cap');
eq(rewrite._internals.clampTimeout(-5), 10000, 'clamp: non-positive -> default');
eq(rewrite._internals.clampTimeout(5000), 5000, 'clamp: in-range preserved');

// ---- summary -----------------------------------------------------------------
console.log('rewrite-test: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
process.exit(0);
