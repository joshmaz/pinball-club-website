/* Stored derivatives work on Supabase Free; originals remain the source of truth. */
(function (root) {
  const widths = [320, 640, 1200];
  function variants(image) {
    const rows = image && (image.variants || (image.metadata && image.metadata.deliveryVariants));
    return (Array.isArray(rows) ? rows : []).filter(v => v && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(v.url) && Number.isInteger(v.width) && v.width > 0)
      .sort((a, b) => a.width - b.width).filter((v, i, a) => !i || v.width !== a[i - 1].width);
  }
  function apply(img, image, detail) {
    const rows = variants(image);
    const fallback = image.url || image.displayUrl || image.locationValue || '';
    const chosen = rows.find(v => v.width >= (detail ? 1200 : 640)) || rows[rows.length - 1];
    img.src = chosen ? chosen.url : fallback;
    if (rows.length) {
      img.srcset = rows.map(v => `${v.url} ${v.width}w`).join(', ');
      img.sizes = detail ? '(max-width: 700px) calc(100vw - 64px), 600px' : '(max-width: 650px) calc(100vw - 64px), (max-width: 1000px) 45vw, 360px';
    } else {
      img.removeAttribute('srcset'); img.removeAttribute('sizes');
    }
  }
  async function animated(file) {
    if (file.type === 'image/gif') return true;
    if (!['image/png', 'image/webp'].includes(file.type)) return false;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const png = file.type === 'image/png';
    for (let offset = png ? 8 : 12; offset + 8 <= bytes.length;) {
      const typeOffset = offset + (png ? 4 : 0);
      const kind = String.fromCharCode(...bytes.slice(typeOffset, typeOffset + 4));
      if (kind === (png ? 'acTL' : 'ANIM')) return true;
      const size = view.getUint32(offset + (png ? 0 : 4), !png);
      offset += png ? size + 12 : size + 8 + (size % 2);
    }
    return false;
  }
  async function generate(file) {
    // Preserve animation; Canvas would silently flatten it to a single frame.
    if (await animated(file)) return [];
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      if (bitmap.width * bitmap.height > 40000000) throw new Error('Photo exceeds the 40 megapixel processing limit.');
      const output = [];
      for (const target of widths) {
        const width = Math.min(target, bitmap.width);
        if (output.some(v => v.width === width)) continue;
        const height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.78));
        if (!blob || blob.type !== 'image/webp') throw new Error('This browser cannot encode WebP photos. Try a current browser.');
        output.push({ target, width, height, blob });
      }
      return output;
    } finally { bitmap.close(); }
  }
  root.SNHGameImages = { variants, apply, generate, widths };
})(typeof window === 'undefined' ? globalThis : window);
