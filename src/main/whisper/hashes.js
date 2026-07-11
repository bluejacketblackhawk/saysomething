'use strict';

/**
 * Pinned SHA-256 digests for downloadable payloads.
 *
 * Supply-chain integrity: HTTPS authenticates the transport, but not that Hugging
 * Face / GitHub are serving the SAME bytes we vetted. A completed download whose
 * key is listed here MUST match its digest before it is renamed into place;
 * anything not listed is downloaded as before (verify-if-known). These are the
 * exact bytes fetched from the pinned URLs and verified end-to-end (transcription
 * works), so they are a trust-on-first-use baseline — update deliberately if the
 * pinned upstream version ever changes.
 */

module.exports = {
  // whisper.cpp v1.9.1 Windows x64 binaries zip (config.WHISPER_ZIP_CACHE).
  'whisper-bin-x64-v1.9.1.zip': '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539',
  // ggml models keyed by catalog name (file is ggml-<name>.bin). The default is
  // pinned; add others here as their digests are vetted.
  'small.en': 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
};
