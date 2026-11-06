// 標準のブラウザ部品だけで写しを作る。失敗しても原本の送信を続ける。
export const PHOTO_SCRIPT = String.raw`(function (root) {
  async function makeReadingCopy(file) {
    if (!/^image\//i.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)) return null;
    if (typeof createImageBitmap !== 'function') return null;
    var bitmap;
    var canvas;
    try {
      bitmap = await createImageBitmap(file);
      var scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      var context = canvas.getContext('2d');
      if (!context) return null;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.85); });
      return blob && blob.type === 'image/jpeg' && blob.size <= 5 * 1024 * 1024 ? blob : null;
    } catch (ignored) { return null; }
    finally {
      if (bitmap) bitmap.close();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }
  root.__sendPhoto = { makeReadingCopy: makeReadingCopy };
  if (typeof document === 'undefined') return;
  document.querySelectorAll('form[data-photo-form]').forEach(function (form) {
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var button = form.querySelector('button[type="submit"]');
      if (button.disabled) return;
      button.disabled = true;
      var status = form.querySelector('[role="status"]');
      status.textContent = '送っています…';
      var data = new FormData(form);
      var file = data.get('file');
      var copy = file && typeof file !== 'string' ? await makeReadingCopy(file) : null;
      if (copy) data.append('reading_copy', copy, 'reading.jpg');
      try {
        var response = await fetch(form.action, { method: 'POST', body: data, credentials: 'same-origin' });
        if (response.redirected) { location.assign(response.url); return; }
        status.textContent = '送れませんでした。もう一度送ってください。';
      } catch (ignored) { status.textContent = '送れませんでした。電波を確かめて、もう一度送ってください。'; }
      button.disabled = false;
    });
  });
})(typeof window !== 'undefined' ? window : globalThis);`;
