(function () {
  'use strict';
  var MAX_INPUT = 50 * 1024 * 1024;
  function dimensions(width, height, max) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Invalid photo dimensions.');
    var ratio = Math.min(1, max / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
  }
  async function convert(file, progress) {
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG, or WebP photo.');
    if (!file.size || file.size > MAX_INPUT) throw new Error('Photos must be under 50 MB.');
    progress = progress || function () {};
    progress('Converting');
    var image;
    try {
      // Browser decoding applies EXIF orientation. Canvas output discards source metadata.
      image = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (image.width * image.height > 80000000) throw new Error('Photo is too large to process. Resize it and retry.');
      var output = [];
      for (var spec of [['web', 1920], ['thumb', 640]]) {
        var size = dimensions(image.width, image.height, spec[1]);
        var canvas = document.createElement('canvas');
        canvas.width = size.width; canvas.height = size.height;
        var context = canvas.getContext('2d');
        if (!context) throw new Error('Image conversion is unavailable.');
        context.drawImage(image, 0, 0, size.width, size.height);
        var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/webp', 0.82); });
        canvas.width = canvas.height = 1;
        if (!blob || blob.type !== 'image/webp') throw new Error('This browser cannot make WebP photos. Try a current browser.');
        if (blob.size > 8 * 1024 * 1024) throw new Error('Converted photo exceeds 8 MB. Resize it and retry.');
        output.push({ variant: spec[0], blob: blob, width: size.width, height: size.height });
      }
      return output;
    } catch (error) {
      throw new Error(error.message || 'Photo could not be converted. Try a JPEG, PNG, or WebP image.');
    } finally { if (image && image.close) image.close(); }
  }
  window.SNHPhotoConversion = { convert: convert, dimensions: dimensions };
})();
