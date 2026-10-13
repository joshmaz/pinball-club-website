# Vendored WebP encoder

Source: @jsquash/webp 1.5.0, https://github.com/jamsinclair/jSquash.
Downloaded from the npm release tarball (shasum
1e8ce357cde2decf4f880a8c436f8f1529cd3f48).

Included unchanged: baseline (non-SIMD) encoder JS/WASM, meta.js defaults, and
package/codec licenses. Decoder and SIMD builds are not shipped. The photo worker
calls the baseline codec directly with quality 82. This avoids a bundler or remote
runtime dependency and works without cross-origin isolation/SharedArrayBuffer.
Only browsers lacking native canvas WebP encoding download this fallback.
