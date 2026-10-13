(function () {
  'use strict';
  var root = document.getElementById('photos-albums'), status = document.getElementById('photos-status');
  var dialog = document.getElementById('photos-lightbox'), full = document.getElementById('photos-full');
  var current = [], index = 0, lastTrigger;
  function variant(asset, name) { return (asset.variants || []).find(function (v) { return v.variant === name && v.bucket === 'photos-public'; }); }
  function url(v) {
    var base = String((window.SNH_CONFIG || {}).supabaseUrl || '').replace(/\/+$/, '');
    return base && v ? base + '/storage/v1/object/public/photos-public/' + v.objectKey.split('/').map(encodeURIComponent).join('/') : '';
  }
  function show() {
    var asset = current[index];
    full.src = url(variant(asset, 'web') || variant(asset, 'thumb'));
    full.alt = asset.altText || asset.caption || 'Club photo';
    document.getElementById('photos-caption').textContent = (asset.caption || '') + ' · ' + (index + 1) + ' of ' + current.length;
    document.getElementById('photos-prev').disabled = current.length < 2;
    document.getElementById('photos-next').disabled = current.length < 2;
  }
  function move(step) { index = (index + step + current.length) % current.length; show(); }
  document.getElementById('photos-close').onclick = function () { dialog.close(); };
  document.getElementById('photos-prev').onclick = function () { move(-1); };
  document.getElementById('photos-next').onclick = function () { move(1); };
  dialog.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
  });
  dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', function () { full.removeAttribute('src'); if (lastTrigger) lastTrigger.focus(); });
  function node(tag, text) { var element = document.createElement(tag); if (text) element.textContent = text; return element; }
  function render(albums) {
    root.replaceChildren();
    var navigation = document.getElementById('photos-album-nav'); navigation.replaceChildren();
    var query = new URLSearchParams(location.search), eventId = query.get('event'), albumId = query.get('album');
    var visible = albums.filter(function (a) { return (!eventId || a.eventId === eventId) && (!albumId || a.id === albumId || a.slug === albumId); });
    if (eventId || albumId) { var all = node('a', 'All albums'); all.href = 'photos.html'; navigation.appendChild(all); }
    visible.forEach(function (album) {
      var assets = (album.assets || []).filter(function (a) { return variant(a, 'web'); });
      if (!assets.length) return;
      var section = node('section'); section.id = 'album-' + album.id;
      var heading = node('h2', album.title); section.appendChild(heading);
      var jump = node('a', album.title); jump.href = '#' + section.id; navigation.appendChild(jump);
      if (album.description) section.appendChild(node('p', album.description));
      if (album.eventTitle) section.appendChild(node('p', 'From ' + album.eventTitle));
      var date = album.displayAt || album.eventStartsAt;
      if (date && !isNaN(Date.parse(date))) section.appendChild(node('p', new Date(date).toLocaleDateString('en-US', { timeZone: 'America/New_York', dateStyle: 'long' })));
      var grid = node('div'); grid.className = 'photos-grid';
      // Cover comes first in browsing order without changing the stored photo order.
      assets = assets.slice().sort(function (a, b) { return Number(b.id === album.coverAssetId) - Number(a.id === album.coverAssetId); });
      assets.forEach(function (asset, position) {
        var figure = node('figure'), button = node('button'); button.type = 'button';
        button.setAttribute('aria-label', 'Open photo: ' + (asset.caption || album.title));
        var image = node('img'), thumb = variant(asset, 'thumb') || variant(asset, 'web');
        image.src = url(thumb); image.alt = asset.altText || asset.caption || album.title; image.loading = 'lazy'; image.decoding = 'async';
        if (thumb.width && thumb.height) { image.width = thumb.width; image.height = thumb.height; }
        button.appendChild(image); button.onclick = function () { current = assets; index = position; lastTrigger = button; show(); dialog.showModal(); };
        figure.appendChild(button); if (asset.caption) figure.appendChild(node('figcaption', asset.caption)); grid.appendChild(figure);
      });
      section.appendChild(grid); root.appendChild(section);
    });
    status.textContent = root.children.length ? '' : 'No published photos are available yet.';
  }
  async function load() {
    try {
      if (!window.snhSupabase) throw new Error('Photo service unavailable');
      var result = await window.snhSupabase.rpc('snh_public_photo_albums'); if (result.error) throw result.error;
      var albums = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
      render(Array.isArray(albums) ? albums : []);
    } catch (error) {
      status.textContent = 'Photos could not be loaded. ';
      var retry = node('button', 'Try again'); retry.type = 'button'; retry.onclick = function () { status.textContent = 'Loading albums…'; void load(); }; status.appendChild(retry);
    }
  }
  void load();
})();
