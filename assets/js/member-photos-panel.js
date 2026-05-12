// Member Photos panel: album list + per-album asset editor.
//
// Wires the dynamic photos foundation into the member portal. Lets photos
// editors manage albums, upload images via server-issued signed URLs, edit
// captions/alt text, publish/unpublish, reorder, and delete (admin).
//
// Authorization is enforced server-side by the RPCs in
// supabase/migrations/20260512120000_photos_rpcs.sql; this UI is a
// convenience layer only.

(function () {
  var appEl = null;
  var statusEl = null;
  var inited = false;
  var albumsCache = [];
  var selectedAlbumId = null;
  var assetsByAlbum = {};
  var lastUserRoles = [];

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "className") n.className = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else if (k === "checked") n.checked = !!attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) n.appendChild(c);
    });
    return n;
  }

  function setStatus(message, kind) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.classList.remove("is-error");
    if (kind === "error") statusEl.classList.add("is-error");
  }

  function isAdmin(userRoles) {
    var admin = ["photos_admin", "club_admin"];
    for (var i = 0; i < (userRoles || []).length; i += 1) {
      if (admin.indexOf(String(userRoles[i])) !== -1) return true;
    }
    return false;
  }

  function friendlyError(err) {
    if (!err) return "Something went wrong.";
    var portal = window.SNHMemberPortal;
    if (portal && typeof portal.getFriendlyAuthErrorMessage === "function") {
      return portal.getFriendlyAuthErrorMessage(err);
    }
    return err.message || String(err);
  }

  function fmtDate(value) {
    var portal = window.SNHMemberPortal;
    if (portal && typeof portal.formatDate === "function") {
      return portal.formatDate(value);
    }
    if (!value) return "Not set";
    var d = new Date(value);
    return Number.isNaN(d.getTime()) ? "Not set" : d.toLocaleDateString();
  }

  function buildAlbumForm(album) {
    var idVal = album ? album.id : "";
    var slugVal = album ? (album.slug || "") : "";
    var titleVal = album ? (album.title || "") : "";
    var descVal = album ? (album.description || "") : "";
    var sortVal = album ? (album.sortPosition != null ? String(album.sortPosition) : "0") : "0";
    var publishedVal = album ? !!album.published : false;

    var form = el("form", { className: "member-photos-album-form members-profile-form" });

    var idInput = el("input", { type: "hidden", id: "member-photos-album-id" });
    idInput.value = idVal;
    form.appendChild(idInput);

    form.appendChild(el("label", { for: "member-photos-album-title", text: "Title" }));
    var titleInput = el("input", { type: "text", id: "member-photos-album-title", maxlength: "200", required: "required" });
    titleInput.value = titleVal;
    form.appendChild(titleInput);

    form.appendChild(el("label", { for: "member-photos-album-slug", text: "Slug" }));
    var slugHint = el("p", {
      className: "member-form-hint",
      text: "Lowercase letters, digits, dash or underscore. Used in URLs and storage paths."
    });
    form.appendChild(slugHint);
    var slugInput = el("input", { type: "text", id: "member-photos-album-slug", maxlength: "80", required: "required", pattern: "[a-z0-9][a-z0-9_\\-]{0,80}" });
    slugInput.value = slugVal;
    form.appendChild(slugInput);

    form.appendChild(el("label", { for: "member-photos-album-description", text: "Description (optional)" }));
    var descInput = el("textarea", { id: "member-photos-album-description", rows: "3", maxlength: "1000" });
    descInput.value = descVal;
    form.appendChild(descInput);

    form.appendChild(el("label", { for: "member-photos-album-sort", text: "Sort position" }));
    var sortInput = el("input", { type: "number", id: "member-photos-album-sort", step: "1" });
    sortInput.value = sortVal;
    form.appendChild(sortInput);

    var publishedLabel = el("label", { className: "members-checkbox-label" });
    var publishedInput = el("input", { type: "checkbox", id: "member-photos-album-published", checked: publishedVal });
    publishedLabel.appendChild(publishedInput);
    publishedLabel.appendChild(document.createTextNode(" Published (visible on public gallery)"));
    form.appendChild(publishedLabel);

    var actions = el("p", { className: "members-admin-toolbar" });
    var saveBtn = el("button", { type: "submit", className: "members-events-form-action", text: album ? "Save changes" : "Create album" });
    actions.appendChild(saveBtn);
    if (album) {
      var cancelBtn = el("button", {
        type: "button",
        className: "members-events-form-action",
        id: "member-photos-album-cancel",
        text: "Clear form"
      });
      actions.appendChild(cancelBtn);

      if (isAdmin(lastUserRoles)) {
        var deleteBtn = el("button", {
          type: "button",
          className: "members-admin-revoke",
          id: "member-photos-album-delete",
          text: "Delete album"
        });
        actions.appendChild(deleteBtn);
      }
    }
    form.appendChild(actions);

    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var fields = {
        slug: slugInput.value.trim().toLowerCase(),
        title: titleInput.value.trim(),
        description: descInput.value.trim(),
        sortPosition: Number(sortInput.value || 0) || 0,
        published: publishedInput.checked
      };
      try {
        setStatus(album ? "Saving album..." : "Creating album...");
        var newId = await window.SNHMemberPortal.photoAlbumUpsert(idVal || null, fields);
        setStatus(album ? "Album updated." : "Album created.");
        await refreshAlbums();
        selectedAlbumId = String(newId || idVal || "");
        await renderApp();
      } catch (err) {
        setStatus(friendlyError(err), "error");
      }
    });

    return { form: form, cancelBtnId: "member-photos-album-cancel", deleteBtnId: "member-photos-album-delete" };
  }

  function buildAssetCard(album, asset) {
    var card = el("article", { className: "member-photos-asset" });
    card.setAttribute("data-asset-id", asset.id);

    var thumbWrap = el("div", { className: "member-photos-asset-thumb" });
    var thumbVariant = pickVariant(asset, "thumb") || pickVariant(asset, "web");
    if (thumbVariant) {
      var img = el("img", {
        alt: asset.altText || asset.caption || "Photo preview",
        loading: "lazy",
        decoding: "async"
      });
      img.src = window.SNHMemberPortal.buildPublicPhotoUrl(thumbVariant.objectKey);
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.appendChild(el("p", {
        className: "member-photos-asset-thumb-placeholder",
        text: asset.status === "pending"
          ? "Upload not finished"
          : "No preview yet (publish to generate)"
      }));
    }
    card.appendChild(thumbWrap);

    var meta = el("div", { className: "member-photos-asset-meta" });
    var statusLine = el("p", {
      className: "member-photos-asset-status",
      text: "Status: " + (asset.status || "pending") + " · " + (asset.originalFilename || "(no filename)")
    });
    meta.appendChild(statusLine);

    var captionLabel = el("label", { text: "Caption" });
    var captionInput = el("input", { type: "text", maxlength: "1000" });
    captionInput.value = asset.caption || "";
    captionInput.setAttribute("data-asset-field", "caption");
    meta.appendChild(captionLabel);
    meta.appendChild(captionInput);

    var altLabel = el("label", { text: "Alt text (for accessibility)" });
    var altInput = el("input", { type: "text", maxlength: "500" });
    altInput.value = asset.altText || "";
    altInput.setAttribute("data-asset-field", "altText");
    meta.appendChild(altLabel);
    meta.appendChild(altInput);

    var sortLabel = el("label", { text: "Sort position" });
    var sortInput = el("input", { type: "number", step: "1" });
    sortInput.value = asset.sortPosition != null ? String(asset.sortPosition) : "0";
    sortInput.setAttribute("data-asset-field", "sortPosition");
    meta.appendChild(sortLabel);
    meta.appendChild(sortInput);

    var actions = el("p", { className: "member-photos-asset-actions" });
    var saveBtn = el("button", { type: "button", className: "members-events-form-action", text: "Save text" });
    saveBtn.addEventListener("click", function () { void saveAssetMeta(asset.id, captionInput, altInput, sortInput); });
    actions.appendChild(saveBtn);

    if (asset.status === "uploaded" || asset.status === "unpublished") {
      var publishBtn = el("button", { type: "button", className: "members-events-form-action", text: "Generate & publish" });
      publishBtn.addEventListener("click", function () { void publishAsset(asset.id); });
      actions.appendChild(publishBtn);
    } else if (asset.status === "published") {
      var unpubBtn = el("button", { type: "button", className: "members-admin-revoke", text: "Unpublish" });
      unpubBtn.addEventListener("click", function () { void unpublishAsset(asset.id); });
      actions.appendChild(unpubBtn);
      var regenBtn = el("button", { type: "button", className: "members-events-form-action", text: "Regenerate variants" });
      regenBtn.addEventListener("click", function () { void publishAsset(asset.id); });
      actions.appendChild(regenBtn);
    }

    if (isAdmin(lastUserRoles)) {
      var delBtn = el("button", { type: "button", className: "members-admin-revoke", text: "Delete asset" });
      delBtn.addEventListener("click", function () { void deleteAsset(asset.id); });
      actions.appendChild(delBtn);
    }

    meta.appendChild(actions);
    card.appendChild(meta);

    return card;
  }

  function pickVariant(asset, name) {
    var variants = (asset && asset.variants) || [];
    for (var i = 0; i < variants.length; i += 1) {
      if (variants[i] && variants[i].variant === name) return variants[i];
    }
    return null;
  }

  async function saveAssetMeta(assetId, captionInput, altInput, sortInput) {
    try {
      setStatus("Saving asset...");
      await window.SNHMemberPortal.photoAssetSetMetadata(assetId, {
        caption: captionInput.value || "",
        altText: altInput.value || "",
        sortPosition: Number(sortInput.value || 0) || 0
      });
      setStatus("Asset updated.");
      await refreshAssets(selectedAlbumId);
      await renderApp();
    } catch (err) {
      setStatus(friendlyError(err), "error");
    }
  }

  async function publishAsset(assetId) {
    try {
      setStatus("Generating derivatives and publishing...");
      await window.SNHMemberPortal.photoPublishAsset(assetId, { publish: true });
      setStatus("Asset published.");
      await refreshAssets(selectedAlbumId);
      await renderApp();
    } catch (err) {
      setStatus(friendlyError(err), "error");
    }
  }

  async function unpublishAsset(assetId) {
    if (!window.confirm("Unpublish this asset? Public derivatives will be removed.")) return;
    try {
      setStatus("Unpublishing...");
      await window.SNHMemberPortal.photoPurgeAsset(assetId, "unpublish");
      setStatus("Asset unpublished and public copies removed.");
      await refreshAssets(selectedAlbumId);
      await renderApp();
    } catch (err) {
      setStatus(friendlyError(err), "error");
    }
  }

  async function deleteAsset(assetId) {
    if (!isAdmin(lastUserRoles)) return;
    if (!window.confirm("Delete this asset? Original and derivatives will be removed permanently.")) return;
    try {
      setStatus("Deleting asset...");
      await window.SNHMemberPortal.photoPurgeAsset(assetId, "delete");
      setStatus("Asset deleted.");
      await refreshAssets(selectedAlbumId);
      await renderApp();
    } catch (err) {
      setStatus(friendlyError(err), "error");
    }
  }

  async function deleteAlbum(albumId) {
    if (!isAdmin(lastUserRoles)) return;
    if (!window.confirm("Delete this album? This will cascade and delete all assets in the album. Storage objects must be cleaned up via per-asset delete first to avoid orphans.")) return;
    try {
      setStatus("Deleting album...");
      var result = await window.SNHMemberPortal.photoAlbumDelete(albumId);
      var orphans = (result && result.cascadedAssetIds) || [];
      setStatus(orphans.length
        ? "Album deleted. " + orphans.length + " asset rows removed; storage objects may remain and need a cleanup pass."
        : "Album deleted.");
      selectedAlbumId = null;
      await refreshAlbums();
      await renderApp();
    } catch (err) {
      setStatus(friendlyError(err), "error");
    }
  }

  async function uploadFiles(albumId, files) {
    if (!files || !files.length) return;
    try {
      for (var i = 0; i < files.length; i += 1) {
        setStatus("Uploading " + (i + 1) + " of " + files.length + ": " + files[i].name);
        await window.SNHMemberPortal.photoUploadAndRegister(albumId, files[i]);
      }
      setStatus("Uploaded " + files.length + " file(s). Click Generate & publish to make them visible.");
      await refreshAssets(albumId);
      await renderApp();
    } catch (err) {
      setStatus(friendlyError(err), "error");
    }
  }

  async function refreshAlbums() {
    try {
      albumsCache = await window.SNHMemberPortal.photoAlbumsListEditor();
    } catch (err) {
      albumsCache = [];
      throw err;
    }
  }

  async function refreshAssets(albumId) {
    if (!albumId) {
      assetsByAlbum = {};
      return;
    }
    try {
      assetsByAlbum[albumId] = await window.SNHMemberPortal.photoAssetsListEditor(albumId);
    } catch (err) {
      assetsByAlbum[albumId] = [];
      throw err;
    }
  }

  async function renderApp() {
    if (!appEl) return;
    appEl.innerHTML = "";

    var topBar = el("p", { className: "members-admin-toolbar" });
    var refreshBtn = el("button", { type: "button", className: "members-sidebar-link", text: "Refresh" });
    refreshBtn.addEventListener("click", async function () {
      try {
        setStatus("Refreshing...");
        await refreshAlbums();
        if (selectedAlbumId) await refreshAssets(selectedAlbumId);
        setStatus("");
        await renderApp();
      } catch (err) {
        setStatus(friendlyError(err), "error");
      }
    });
    topBar.appendChild(refreshBtn);
    appEl.appendChild(topBar);

    var layout = el("div", { className: "member-photos-layout" });

    var leftCol = el("section", { className: "member-photos-albums-col" });
    leftCol.appendChild(el("h4", { text: "Albums" }));

    if (!albumsCache.length) {
      leftCol.appendChild(el("p", {
        className: "member-form-hint",
        text: "No albums yet. Create one below to start uploading photos."
      }));
    } else {
      var ul = el("ul", { className: "member-photos-album-list" });
      for (var i = 0; i < albumsCache.length; i += 1) {
        var alb = albumsCache[i];
        var li = el("li", {
          className: selectedAlbumId === String(alb.id)
            ? "member-photos-album-list-item is-active"
            : "member-photos-album-list-item"
        });
        var btn = el("button", { type: "button", className: "members-sidebar-link" });
        var counts = alb.assetCounts || { total: 0, published: 0 };
        btn.textContent = (alb.title || "(untitled)") +
          " (" + (counts.published || 0) + "/" + (counts.total || 0) + " published)" +
          (alb.published ? "" : " [draft]");
        (function (id) {
          btn.addEventListener("click", function () {
            selectedAlbumId = String(id);
            void refreshAssets(selectedAlbumId).then(renderApp).catch(function (err) {
              setStatus(friendlyError(err), "error");
            });
          });
        })(alb.id);
        li.appendChild(btn);
        ul.appendChild(li);
      }
      leftCol.appendChild(ul);
    }

    leftCol.appendChild(el("h4", { text: "Album editor" }));
    var selectedAlbum = albumsCache.find(function (a) { return String(a.id) === String(selectedAlbumId); }) || null;
    var formBundle = buildAlbumForm(selectedAlbum);
    leftCol.appendChild(formBundle.form);
    if (selectedAlbum) {
      var cancelBtn = formBundle.form.querySelector("#" + formBundle.cancelBtnId);
      if (cancelBtn) {
        cancelBtn.addEventListener("click", function () {
          selectedAlbumId = null;
          void renderApp();
        });
      }
      var deleteAlbumBtn = formBundle.form.querySelector("#" + formBundle.deleteBtnId);
      if (deleteAlbumBtn) {
        deleteAlbumBtn.addEventListener("click", function () {
          void deleteAlbum(selectedAlbum.id);
        });
      }
    }

    layout.appendChild(leftCol);

    var rightCol = el("section", { className: "member-photos-assets-col" });

    if (!selectedAlbum) {
      rightCol.appendChild(el("p", {
        className: "member-form-hint",
        text: "Select an album on the left, or create one to upload photos."
      }));
    } else {
      rightCol.appendChild(el("h4", { text: "Photos in: " + (selectedAlbum.title || selectedAlbum.slug) }));
      rightCol.appendChild(el("p", {
        className: "member-form-hint",
        text: "Last updated " + fmtDate(selectedAlbum.updatedAt) + " · Slug: " + (selectedAlbum.slug || "(none)")
      }));

      var uploadWrap = el("p", { className: "members-admin-toolbar" });
      uploadWrap.appendChild(el("label", { for: "member-photos-upload-input", text: "Upload (JPEG or PNG, up to 50 MB):" }));
      var fileInput = el("input", {
        type: "file",
        id: "member-photos-upload-input",
        accept: "image/jpeg,image/png",
        multiple: "multiple"
      });
      fileInput.addEventListener("change", function () {
        var files = fileInput.files ? Array.prototype.slice.call(fileInput.files) : [];
        if (files.length === 0) return;
        void uploadFiles(selectedAlbum.id, files).then(function () {
          fileInput.value = "";
        });
      });
      uploadWrap.appendChild(fileInput);
      rightCol.appendChild(uploadWrap);

      var assets = assetsByAlbum[selectedAlbum.id] || [];
      if (!assets.length) {
        rightCol.appendChild(el("p", {
          className: "member-form-hint",
          text: "No photos in this album yet."
        }));
      } else {
        var grid = el("div", { className: "member-photos-grid" });
        for (var j = 0; j < assets.length; j += 1) {
          grid.appendChild(buildAssetCard(selectedAlbum, assets[j]));
        }
        rightCol.appendChild(grid);
      }
    }

    layout.appendChild(rightCol);
    appEl.appendChild(layout);
  }

  async function init(userRoles) {
    lastUserRoles = userRoles || [];
    if (!appEl) appEl = document.getElementById("member-photos-app");
    if (!statusEl) statusEl = document.getElementById("member-photos-status");
    if (!appEl) return;

    if (!window.SNHMemberPortal || !window.SNHMemberPortal.photoAlbumsListEditor) {
      appEl.innerHTML = "<p class=\"member-form-hint\">Photo tools are unavailable. Apply migrations and reload.</p>";
      return;
    }

    if (!inited) {
      inited = true;
      try {
        setStatus("Loading albums...");
        await refreshAlbums();
        setStatus("");
      } catch (err) {
        setStatus(friendlyError(err), "error");
      }
    } else {
      try {
        await refreshAlbums();
        if (selectedAlbumId) await refreshAssets(selectedAlbumId);
      } catch (err) {
        setStatus(friendlyError(err), "error");
      }
    }
    await renderApp();
  }

  window.SNHMemberPhotosPanel = { init: init };
})();
