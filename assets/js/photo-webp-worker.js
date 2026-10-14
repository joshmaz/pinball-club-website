// Browser-only fallback. Run the baseline codec off the UI thread.
import createEncoder from '../vendor/jsquash-webp/webp_enc.js';
import { defaultOptions } from '../vendor/jsquash-webp/meta.js';
let encoder;
self.onmessage = async function (event) {
  try {
    encoder = encoder || createEncoder();
    const codec = await encoder;
    const { pixels, width, height } = event.data;
    const encoded = codec.encode(new Uint8ClampedArray(pixels), width, height, {
      ...defaultOptions, quality: 82
    });
    if (!encoded) throw new Error('WebP encoding failed.');
    const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    self.postMessage({ buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || 'WebP encoding failed.' });
  }
};
