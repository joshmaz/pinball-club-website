(function () {
  'use strict';
  var root = document.getElementById('photos-albums'), status = document.getElementById('photos-status');
  var dialog = document.getElementById('photos-lightbox'), full = document.getElementById('photos-full');
  var current = [], index = 0, lastTrigger;
  var canEdit = false, accessRevision = 0;
  function albumEditorHref(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? "members.html?panel=photos&album=" + encodeURIComponent(id) : "";
  }
  function updateEditActions() {
    root.querySelectorAll(".photos-edit-actions").forEach(function (actions) {
      actions.replaceChildren();
      var href = canEdit ? albumEditorHref(actions.dataset.albumId) : "";
      actions.hidden = !href;
      if (!href) return;
      var edit = node("a", "Edit Album"); edit.className = "event-edit-link"; edit.href = href;
      edit.setAttribute("aria-label", "Edit " + actions.dataset.albumTitle + " in Member Tools");
      actions.appendChild(edit);
    });
  }
  async function refreshEditAccess() {
    var revision = ++accessRevision; canEdit = false; updateEditActions();
    try {
      var auth = window.SNHSiteAuth; if (!auth) return;
      var session = await auth.getSession(); if (!session || !session.user) return;
      var roles = await auth.fetchMemberRoles(session.user.id);
      if (revision !== accessRevision) return;
      canEdit = auth.can(roles, "photos.manage"); updateEditActions();
    } catch (_) { /* Public browsing remains available if edit access cannot be resolved. */ }
  }
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
    var visible = albums.filter(function (a) { return (!eventId || a.eventId === eventId) && (!albumId || a.id === albumId || a.slug === albumId); })
      .map(function (album) {
        var assets = (album.assets || []).filter(function (a) { return variant(a, 'web'); });
        // Cover first without changing the stored order of the remaining photos.
        assets.sort(function (a, b) { return Number(b.id === album.coverAssetId) - Number(a.id === album.coverAssetId); });
        return { album: album, assets: assets };
      }).filter(function (item) { return item.assets.length; });
    if (eventId || albumId) { var all = node('a', 'All albums'); all.href = 'photos.html'; navigation.appendChild(all); }
    function createAlbum(item) {
      var album = item.album, assets = item.assets;
      var section = node('details'); section.className = 'photos-album'; section.id = 'album-' + album.id;
      var summary = node('summary'), cover = node('img'), coverVariant = variant(assets[0], 'thumb') || variant(assets[0], 'web');
      cover.src = url(coverVariant); cover.alt = ''; cover.loading = 'lazy'; cover.decoding = 'async'; cover.width = 96; cover.height = 72;
      summary.appendChild(cover);
      var label = node('div'); label.appendChild(node('h2', album.title));
      label.appendChild(node('span', assets.length + (assets.length === 1 ? ' photo' : ' photos')));
      summary.appendChild(label); section.appendChild(summary);
      var body = node('div'); body.className = 'photos-album-body'; section.appendChild(body);
      function openAlbum() {
        if (!section.open) { body.replaceChildren(); return; }
        if (body.children.length) return;
        var actions = node("p"); actions.className = "event-card-actions photos-album-actions";
        var albumHref = "photos.html?album=" + encodeURIComponent(album.id);
        var view = node("a", "View album"); view.href = albumHref; view.className = "event-edit-link";
        view.setAttribute("aria-label", "View " + album.title + " album"); actions.appendChild(view);
        var editActions = node("span"); editActions.className = "photos-edit-actions";
        editActions.dataset.albumId = album.id; editActions.dataset.albumTitle = album.title;
        actions.appendChild(editActions); body.appendChild(actions);
        updateEditActions();
        if (album.description) body.appendChild(node('p', album.description));
        if (album.eventTitle) body.appendChild(node('p', 'From ' + album.eventTitle));
        var date = album.displayAt || album.eventStartsAt;
        if (date && !isNaN(Date.parse(date))) body.appendChild(node('p', new Date(date).toLocaleDateString('en-US', { timeZone: 'America/New_York', dateStyle: 'long' })));
        var grid = node('div'); grid.className = 'photos-grid'; body.appendChild(grid);
        var more = node('button'); more.type = 'button'; more.className = 'photos-more'; body.appendChild(more);
        var shown = 0;
        function addPhotos() {
          var end = Math.min(shown + 24, assets.length);
          while (shown < end) {
            (function (asset, position) {
              var figure = node('figure'), button = node('button'); button.type = 'button';
              button.setAttribute('aria-label', 'Open photo: ' + (asset.caption || album.title));
              var image = node('img'), thumb = variant(asset, 'thumb') || variant(asset, 'web');
              image.src = url(thumb); image.alt = asset.altText || asset.caption || album.title; image.loading = 'lazy'; image.decoding = 'async';
              if (thumb.width && thumb.height) { image.width = thumb.width; image.height = thumb.height; }
              button.appendChild(image); button.onclick = function () { current = assets; index = position; lastTrigger = button; show(); dialog.showModal(); };
              figure.appendChild(button); if (asset.caption) figure.appendChild(node('figcaption', asset.caption)); grid.appendChild(figure);
            })(assets[shown], shown);
            shown += 1;
          }
          more.hidden = shown === assets.length;
          more.textContent = 'Show more photos (' + (assets.length - shown) + ' remaining)';
          more.setAttribute('aria-label', 'Show more photos in ' + album.title);
        }
        more.onclick = addPhotos; addPhotos();
      }
      section.addEventListener('toggle', openAlbum);
      // Event links lead to album choices; direct album links open that album.
      if (albumId) { section.open = true; openAlbum(); }
      return section;
    }
    var shown = 0, moreAlbums = node('button'); moreAlbums.type = 'button'; moreAlbums.className = 'photos-more';
    moreAlbums.id = 'photos-more-albums'; root.appendChild(moreAlbums);
    function addAlbums() {
      var end = Math.min(shown + 12, visible.length), first;
      while (shown < end) {
        var section = createAlbum(visible[shown]); if (!first) first = section.querySelector('summary');
        root.insertBefore(section, moreAlbums); shown += 1;
      }
      moreAlbums.hidden = shown === visible.length;
      moreAlbums.textContent = 'Show more albums (' + (visible.length - shown) + ' remaining)';
      status.textContent = visible.length ? shown + ' of ' + visible.length + ' albums. Select an album to see its photos.' : 'No published photos are available yet.';
      return first;
    }
    moreAlbums.onclick = function () { var first = addAlbums(); if (first) first.focus(); };
    addAlbums(); updateEditActions();
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
  if (window.SNHSiteAuth) window.SNHSiteAuth.onAuthStateChange(function () { void refreshEditAccess(); });
  void refreshEditAccess();
  void load();
})();
