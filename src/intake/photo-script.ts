// スマホの標準機能で写真を整えてから送る。失敗しても送信を続ける。
export const PHOTO_SCRIPT = String.raw`(function (root) {
  function isPhoto(file) {
    return /^image\//i.test(file.type) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name);
  }
  async function loadImage(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file); } catch (ignored) { /* Safariで開ける場合はimgで続ける。 */ }
    }
    var url = URL.createObjectURL(file);
    try {
      return await new Promise(function (resolve, reject) {
        var img = document.createElement('img');
        img.onload = function () { resolve(img); };
        img.onerror = reject;
        img.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
  }
  async function preparePhoto(file) {
    var lastModified = file.lastModified;
    var unchanged = { file: file, sourceHash: '', lastModified: lastModified };
    if (!isPhoto(file)) return unchanged;
    var bitmap;
    var canvas;
    try {
      // 印を作れない端末では、元の写真を送りサーバーに任せる。
      var digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      var sourceHash = Array.from(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      bitmap = await loadImage(file);
      var scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      var context = canvas.getContext('2d');
      if (!context) return unchanged;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.85); });
      return blob && blob.type === 'image/jpeg' && blob.size <= 5 * 1024 * 1024 ? { file: blob, sourceHash: sourceHash, lastModified: lastModified } : unchanged;
    } catch (ignored) { return unchanged; }
    finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }
  root.__sendPhoto = { preparePhoto: preparePhoto };
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
      if (file && typeof file !== 'string') {
        var prepared = await preparePhoto(file);
        data.set('file', prepared.file, prepared.sourceHash ? file.name.replace(/\.[^.]*$/, '') + '.jpg' : file.name);
        data.set('source_hash', prepared.sourceHash);
        data.set('last_modified', String(prepared.lastModified || ''));
      }
      try {
        var response = await fetch(form.action, { method: 'POST', body: data, credentials: 'same-origin' });
        if (response.redirected) { location.assign(response.url); return; }
        status.textContent = '送れませんでした。もう一度送ってください。';
      } catch (ignored) { status.textContent = '送れませんでした。電波を確かめて、もう一度送ってください。'; }
      button.disabled = false;
    });
  });
})(typeof window !== 'undefined' ? window : globalThis);`;
