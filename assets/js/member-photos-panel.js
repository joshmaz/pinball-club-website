// Member Photos panel: album workspace, drag/drop queue, covers and publication.
//
// Wires the dynamic photos foundation into the member portal. Lets photos
// editors manage albums, upload images via server-issued signed URLs, edit
// captions/alt text, publish/unpublish, reorder, and delete (admin).
//
// Authorization is enforced server-side by the photos RPC migrations
// (see supabase/migrations/20260512120000_photos_rpcs.sql and
// 20260519091000_photo_albums_events_rpcs.sql); this UI is a convenience
// layer only.

(function () {
  var appEl = null;
  var statusEl = null;
  var inited = false;
  var albumsCache = [];
  var uploadJobs = [];
  var uploading = false;
  var publishing = false;
  var albumDrafts = {};
  var publicationStatus = "";
  var selectedAlbumId = null;
  var assetsByAlbum = {};
  var eventsForLink = [];
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

  function setUploadInlineStatus(message) {
    var u = document.getElementById("member-photos-upload-inline-status");
    if (u) u.textContent = message || "";
  }

  function setStatus(message, kind) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    if (!message) setUploadInlineStatus("");
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

  function toDatetimeLocalValue(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    function p(n) {
      return String(n).padStart(2, "0");
    }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  async function loadEventsForLink() {
    if (!window.SNHMemberPortal || !window.SNHMemberPortal.photoEventsListForPhotoLink) {
      eventsForLink = [];
      return;
    }
    try {
      eventsForLink = await window.SNHMemberPortal.photoEventsListForPhotoLink();
    } catch (_e) {
      eventsForLink = [];
    }
  }

  function albumFields(album) {
    var form = document.getElementById("member-photos-album-form");
    return form && form.photoFields ? form.photoFields() : {
      slug: album.slug, title: album.title, description: album.description,
      sortPosition: album.sortPosition, published: album.published,
      includeInHighlights: album.includeInHighlights, eventId: album.eventId, displayAt: album.displayAt
    };
  }

  function buildAlbumForm(album) {
    var key = album ? String(album.id) : "new";
    var values = Object.assign({}, album || {}, albumDrafts[key] || {});
    var form = el("form", { id: "member-photos-album-form", className: "member-photos-album-form members-profile-form" });
    function field(label, id, type, value, max) {
      form.appendChild(el("label", { for: id, text: label }));
      var input = el(type === "textarea" ? "textarea" : "input", { id: id });
      if (type !== "textarea") input.type = type;
      else input.rows = 3;
      if (max) input.maxLength = max;
      input.value = value || "";
      form.appendChild(input);
      return input;
    }
    var title = field("Album title", "member-photos-album-title", "text", values.title, 200);
    title.required = true;
    var description = field("Description (optional)", "member-photos-album-description", "textarea", values.description, 1000);
    form.appendChild(el("label", { for: "member-photos-album-event", text: "Event (optional)" }));
    var event = el("select", { id: "member-photos-album-event" });
    event.appendChild(el("option", { value: "", text: "No linked event" }));
    eventsForLink.forEach(function (item) {
      event.appendChild(el("option", { value: item.id, text: item.title + (item.startsAt ? " · " + fmtDate(item.startsAt) : "") }));
    });
    event.value = values.eventId || "";
    form.appendChild(event);

    var defaultOrder = album ? 0 : Math.max.apply(null, [0].concat(albumsCache.map(function (item) { return Number(item.sortPosition) || 0; }))) + 10;
    var order = field("Album order", "member-photos-album-sort", "number", values.sortPosition != null ? String(values.sortPosition) : String(defaultOrder));
    order.step = "1";
    var orderHint = el("p", { id: "member-photos-order-hint", className: "member-form-hint", text: "Lower numbers appear first. Use 10, 20, 30 to leave room for albums in between. Albums with the same number sort alphabetically by title." });
    order.setAttribute("aria-describedby", orderHint.id);
    form.appendChild(orderHint);
    var optional = el("details", { className: "photo-optional-settings" });
    optional.appendChild(el("summary", { text: "More album options" }));
    var slug = field("Album URL", "member-photos-album-slug", "text", values.slug, 80);
    slug.required = true;
    slug.pattern = "[a-z0-9][a-z0-9_-]{0,80}";
    var date = field("Display date (optional)", "member-photos-album-display-at", "datetime-local", toDatetimeLocalValue(values.displayAt));
    [slug, date].forEach(function (input) {
      optional.appendChild(form.querySelector('label[for="' + input.id + '"]'));
      optional.appendChild(input);
    });
    var highlightsLabel = el("label", { className: "members-checkbox-label" });
    var highlights = el("input", { type: "checkbox", checked: !!values.includeInHighlights });
    highlightsLabel.appendChild(highlights);
    highlightsLabel.appendChild(document.createTextNode(" Feature on the Events page"));
    optional.appendChild(highlightsLabel);
    form.appendChild(optional);
    title.addEventListener("input", function () {
      if (!album) slug.value = title.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "album";
    });
    form.photoFields = function () {
      return { title: title.value.trim(), description: description.value.trim(), slug: slug.value.trim().toLowerCase(),
        sortPosition: Number(order.value || 0) || 0, displayAt: date.value ? new Date(date.value).toISOString() : null,
        eventId: event.value || null, includeInHighlights: highlights.checked, published: !!(album && album.published) };
    };
    function remember() { albumDrafts[key] = form.photoFields(); }
    form.addEventListener("input", remember);
    form.addEventListener("change", remember);
    var actions = el("div", { className: "photo-action-row" });
    var save = el("button", { type: "submit", className: "members-events-form-action", text: album ? "Save details" : "Create album" });
    save.disabled = publishing;
    actions.appendChild(save);
    if (album && isAdmin(lastUserRoles)) {
      var remove = el("button", { type: "button", className: "members-admin-revoke", text: "Delete album" });
      remove.disabled = uploading || publishing;
      remove.onclick = function () { void deleteAlbum(album.id); };
      actions.appendChild(remove);
    }
    form.appendChild(actions);
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (publishing) return;
      save.disabled = true;
      try {
        var id = await window.SNHMemberPortal.photoAlbumUpsert(album ? album.id : null, form.photoFields());
        delete albumDrafts[key];
        selectedAlbumId = String(id || (album && album.id));
        await refreshAlbums();
        await refreshAssets(selectedAlbumId);
        await renderApp();
        setStatus(album ? "Album details saved." : "Album created. Add photos, choose a cover, then publish when ready.");
      } catch (error) { setStatus(friendlyError(error), "error"); save.disabled = false; }
    });
    if (publishing) form.querySelectorAll("input, textarea, select, button").forEach(function (control) { control.disabled = true; });
    return form;
  }

  function setPhotoPreview(image, asset) {
    var variant = pickVariant(asset, "thumb") || pickVariant(asset, "web");
    if (!variant) return;
    if (variant.bucket === "photos-private") {
      void window.SNHMemberPortal.photoPreview(asset.id).then(function (url) { image.src = url; })
        .catch(function () { image.alt = "Preview unavailable. Refresh to try again."; });
    } else image.src = window.SNHMemberPortal.buildPublicPhotoUrl(variant.objectKey);
  }

  async function selectCover(album, assetId) {
    if (publishing || uploading) return;
    try {
      var fields = albumFields(album);
      fields.coverAssetId = assetId;
      await window.SNHMemberPortal.photoAlbumUpsert(album.id, fields);
      delete albumDrafts[String(album.id)];
      await refreshAlbums();
      await renderApp();
      setStatus(assetId ? "Album cover selected." : "The first published photo will be used as the cover.");
    } catch (error) { setStatus(friendlyError(error), "error"); }
  }

  async function publishAlbum(album) {
    if (uploading || publishing) return;
    var failedUploads = uploadJobs.filter(function (job) { return job.albumId === String(album.id) && job.error; });
    if (failedUploads.length) { setStatus("Retry or dismiss failed uploads before publishing this album.", "error"); return; }
    var form = document.getElementById("member-photos-album-form");
    if (!form.checkValidity()) {
      form.closest("details").open = true;
      form.querySelector(".photo-optional-settings").open = true;
      form.reportValidity();
      return;
    }
    var fields = form.photoFields();
    publishing = true;
    publicationStatus = "Checking photos…";
    await renderApp();
    var failures = [];
    try {
      await refreshAssets(album.id);
      var assets = assetsByAlbum[album.id] || [];
      var ready = assets.filter(function (asset) { return asset.status === "uploaded" || (asset.status === "pending" && asset.hasOriginal); });
      if (!ready.length && !assets.some(function (asset) { return asset.status === "published"; })) throw new Error("Add at least one photo before publishing.");
      for (var i = 0; i < ready.length; i += 1) {
        var photo = ready[i];
        publicationStatus = "Publishing photo " + (i + 1) + " of " + ready.length + "…";
        updatePublicationControls();
        try {
          if ((photo.uploadMode === "legacy" && !pickVariant(photo, "web")) || (photo.status === "pending" && photo.hasOriginal)) {
            await window.SNHMemberPortal.photoConvertLegacy(album.id, photo.id);
          }
          await window.SNHMemberPortal.photoPublishAsset(photo.id, { publish: true });
        } catch (error) { failures.push((photo.originalFilename || "Photo") + ": " + friendlyError(error)); }
      }
      if (failures.length) throw new Error("Album publication did not finish. " + failures.join(" · ") + ". Retry publishing to finish the remaining photos.");
      fields.published = true;
      await window.SNHMemberPortal.photoAlbumUpsert(album.id, fields);
      delete albumDrafts[String(album.id)];
      setStatus("Album published. It is now visible in the public gallery.");
    } catch (error) { setStatus(friendlyError(error), "error"); }
    finally {
      publishing = false;
      publicationStatus = "";
      try { await refreshAssets(album.id); await refreshAlbums(); await renderApp(); }
      catch (error) { setStatus(friendlyError(error), "error"); }
    }
  }

  async function hideAlbum(album) {
    if (uploading || publishing) return;
    try {
      var fields = albumFields(album);
      fields.published = false;
      await window.SNHMemberPortal.photoAlbumUpsert(album.id, fields);
      delete albumDrafts[String(album.id)];
      await refreshAlbums(); await renderApp();
      setStatus("Album hidden from the public gallery. Its photos are retained.");
    } catch (error) { setStatus(friendlyError(error), "error"); }
  }

  function updatePublicationControls() {
    var button = document.getElementById("member-photos-publish-album");
    if (button) {
      button.disabled = uploading || publishing;
      button.textContent = publishing ? publicationStatus : button.dataset.idleLabel;
    }
    var zone = document.getElementById("member-photos-drop-zone");
    if (zone) zone.setAttribute("aria-disabled", String(publishing));
    if (uploading || publishing) appEl.querySelectorAll(".member-photos-asset button").forEach(function (control) { control.disabled = true; });
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
      if(thumbVariant.bucket === "photos-private") {
        void window.SNHMemberPortal.photoPreview(asset.id).then(function(url){img.src=url;}).catch(function(){img.alt="Preview unavailable; retry after refreshing.";});
      } else img.src = window.SNHMemberPortal.buildPublicPhotoUrl(thumbVariant.objectKey);
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

    var meta = el("details", { className: "member-photos-asset-meta" });
    meta.appendChild(el("summary", { text: "Caption and photo settings" }));
    var statusLine = el("p", {
      className: "member-photos-asset-status",
      text: ({pending:"Upload unfinished",uploaded:"Ready to publish",published:"Published",unpublished:"Hidden"}[asset.status] || "Photo") + " · " + (asset.originalFilename || "Photo")
    });
    card.appendChild(statusLine);

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

    var excludeWrap = el("label", { className: "members-checkbox-label" });
    var excludeInput = el("input", { type: "checkbox", checked: !!asset.excludeFromSlideshow });
    excludeWrap.appendChild(excludeInput);
    excludeWrap.appendChild(document.createTextNode(" Exclude from home highlights mosaic"));
    meta.appendChild(excludeWrap);

    meta.appendChild(el("label", { text: "Promo role (requires linked event on this album)" }));
    var promoSelect = el("select", { "aria-label": "Promo role" });
    var promoOpts = [
      ["", "Normal gallery"],
      ["event_hero", "Event hero (headers, share preview)"],
      ["event_branding", "Event branding"]
    ];
    for (var pi = 0; pi < promoOpts.length; pi += 1) {
      var po = el("option", { value: promoOpts[pi][0], text: promoOpts[pi][1] });
      if ((asset.promoRole || "") === promoOpts[pi][0]) po.selected = true;
      promoSelect.appendChild(po);
    }
    if (!album.eventId) {
      promoSelect.disabled = true;
      promoSelect.title = "Link this album to an event above to use promo roles.";
    }
    meta.appendChild(promoSelect);

    var actions = el("p", { className: "member-photos-asset-actions" });
    var saveBtn = el("button", { type: "button", className: "members-events-form-action", text: "Save text" });
    saveBtn.addEventListener("click", function () { void saveAssetMeta(asset.id, captionInput, altInput, sortInput, excludeInput, promoSelect); });
    actions.appendChild(saveBtn);

    if (asset.status === "uploaded" || asset.status === "unpublished" || (asset.status === "pending" && asset.hasOriginal)) {
      var publishBtn = el("button", { type: "button", className: "members-events-form-action", text: "Publish photo" });
      var legacyJob={};
      publishBtn.addEventListener("click", async function () {
        publishBtn.disabled=true;
        try {
          if((asset.uploadMode==="legacy" && !pickVariant(asset,"web")) || (asset.status==="pending" && asset.hasOriginal)) await window.SNHMemberPortal.photoConvertLegacy(album.id,asset.id,legacyJob);
          await publishAsset(asset.id);
        } catch(err){setStatus(friendlyError(err),"error");}finally{publishBtn.disabled=false;}
      });
      actions.appendChild(publishBtn);
    } else if (asset.status === "published") {
      var unpubBtn = el("button", { type: "button", className: "members-admin-revoke", text: "Unpublish" });
      unpubBtn.addEventListener("click", function () { void unpublishAsset(asset.id); });
      actions.appendChild(unpubBtn);

    }

    if (isAdmin(lastUserRoles)) {
      var delBtn = el("button", { type: "button", className: "members-admin-revoke", text: "Delete asset" });
      delBtn.addEventListener("click", function () { void deleteAsset(asset.id); });
      actions.appendChild(delBtn);
    }

    var isCover = album.coverAssetId === asset.id;
    if (isCover) {
      card.classList.add("is-cover");
      thumbWrap.appendChild(el("span", { className: "photo-cover-badge", text: "Album cover" }));
    }
    var coverBtn = el("button", { type: "button", className: "members-events-form-action photo-cover-action", text: isCover ? "Selected cover" : "Use as cover", "aria-pressed": String(isCover) });
    coverBtn.disabled = isCover || uploading || publishing || asset.status === "pending";
    coverBtn.onclick = function () { void selectCover(album, asset.id); };
    card.appendChild(coverBtn);
    if (asset.status === "published" && album.published) {
      var reuse = el("details"); reuse.appendChild(el("summary", {text:"Reuse for event promotion"}));
      var picker = el("select", {"aria-label":"Event to promote with this photo"});
      eventsForLink.forEach(function (event) { picker.appendChild(el("option", {value:event.id,text:event.title})); });
      reuse.appendChild(picker);
      [false,true].forEach(function(clear) {
        var use = el("button", {type:"button",text:clear?"Clear event override":"Use as event hero"});
        use.addEventListener("click",async function(){
          if (!picker.value) return;
          try { await window.SNHMemberPortal.photoSetEventPromo(picker.value,clear?null:asset.id); setStatus(clear?"Event override cleared.":"Photo linked for event promotion."); }
          catch(err){setStatus(friendlyError(err),"error");}
        }); reuse.appendChild(use);
      });
      meta.appendChild(reuse);
    }
    meta.appendChild(actions);
    card.appendChild(meta);

    if (uploading || publishing) card.querySelectorAll("input, select, button").forEach(function (control) { control.disabled = true; });
    return card;
  }

  function pickVariant(asset, name) {
    var variants = (asset && asset.variants) || [];
    for (var i = 0; i < variants.length; i += 1) {
      if (variants[i] && variants[i].variant === name) return variants[i];
    }
    return null;
  }

  async function saveAssetMeta(assetId, captionInput, altInput, sortInput, excludeInput, promoSelect) {
    try {
      setStatus("Saving asset...");
      await window.SNHMemberPortal.photoAssetSetMetadata(assetId, {
        caption: captionInput.value || "",
        altText: altInput.value || "",
        sortPosition: Number(sortInput.value || 0) || 0,
        excludeFromSlideshow: !!(excludeInput && excludeInput.checked),
        promoRole: promoSelect && promoSelect.value ? promoSelect.value : null
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
      setStatus("Publishing photo...");
      await window.SNHMemberPortal.photoPublishAsset(assetId, { publish: true });
      setStatus("Asset published.");
      await refreshAssets(selectedAlbumId);
      await renderApp();
    } catch (err) {
      setStatus(friendlyError(err), "error");
    }
  }

  async function unpublishAsset(assetId) {
    if (!window.confirm("Unpublish this photo? It will leave the gallery. Its resized copies remain available for republishing.")) return;
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
    if (!window.confirm("Delete this album and all its photos permanently? Storage cleanup will be queued and retried if needed.")) return;
    try {
      setStatus("Deleting album...");
      var result = await window.SNHMemberPortal.photoDeleteAlbumAndCleanup(albumId);
      setStatus(result.cleanupPending ? "Album deleted; storage cleanup is queued for retry." : "Album deleted.");
      selectedAlbumId = null;
      await refreshAlbums();
      await renderApp();
    } catch (err) {
      setStatus(friendlyError(err), "error");
    }
  }

  function renderUploadJobs() {
    var list = document.getElementById("member-photos-upload-jobs");
    var summary = document.getElementById("member-photos-batch-summary");
    var panel = document.getElementById("member-photos-batch");
    if (!list || !summary || !panel) return;
    var jobs = uploadJobs.filter(function (job) { return job.albumId === selectedAlbumId; });
    panel.hidden = !jobs.length;
    list.replaceChildren();
    var ready = jobs.filter(function (job) { return job.done; }).length;
    var failed = jobs.filter(function (job) { return job.error; }).length;
    var percent = jobs.length ? Math.round(jobs.reduce(function (total, job) { return total + (job.progress || 0); }, 0) / jobs.length) : 0;
    summary.textContent = ready + " of " + jobs.length + " photos ready" + (failed ? " · " + failed + " need attention" : "") + (uploading ? " · Uploading" : "");
    var overall = document.getElementById("member-photos-batch-progress");
    overall.value = percent;
    document.getElementById("member-photos-batch-percent").textContent = percent + "%";
    jobs.forEach(function (job) {
      var row = el("li", { className: "photo-upload-job" + (job.error ? " is-error" : job.done ? " is-done" : "") });
      row.appendChild(el("strong", { text: job.filename }));
      row.appendChild(el("span", { className: "photo-job-status", text: job.status }));
      var progress = el("progress", { max: "100", value: String(job.progress || 0), "aria-label": "Processing " + job.filename });
      row.appendChild(progress);
      row.appendChild(el("span", { className: "photo-job-percent", text: Math.round(job.progress || 0) + "%" }));
      if (job.error) {
        var retry = el("button", { type: "button", className: "members-events-form-action", text: "Retry", "aria-label": "Retry " + job.filename });
        retry.disabled = uploading || publishing;
        retry.onclick = function () { job.error = false; job.status = "Waiting"; void runUploadJobs(); };
        row.appendChild(retry);
        var dismiss = el("button", { type: "button", className: "members-events-form-action", text: "Dismiss", "aria-label": "Dismiss " + job.filename });
        dismiss.disabled = uploading || publishing;
        dismiss.onclick = function () { uploadJobs = uploadJobs.filter(function (item) { return item !== job; }); renderUploadJobs(); };
        row.appendChild(dismiss);
      }
      list.appendChild(row);
    });
    var retryAll = document.getElementById("member-photos-retry-failed");
    retryAll.hidden = !failed;
    retryAll.disabled = uploading || publishing;
    var clear = document.getElementById("member-photos-clear-completed");
    clear.hidden = !ready;
    clear.disabled = uploading || publishing;
    var input = document.getElementById("member-photos-upload-input");
    if (input) input.disabled = publishing;
    updatePublicationControls();
  }

  async function runUploadJobs() {
    if (uploading || publishing) return;
    uploading = true;
    renderUploadJobs();
    for (var job of uploadJobs) {
      if (job.done || job.error) continue;
      try {
        job.onProgress = function (text, percent) {
          job.status = text;
          if (Number.isFinite(percent)) job.progress = Math.max(0, Math.min(100, percent));
          renderUploadJobs();
        };
        var result = await window.SNHMemberPortal.photoUploadAndRegister(job.albumId, job.file, job);
        job.assetId = result.assetId;
        job.done = true;
        job.progress = 100;
        job.status = "Ready to publish";
        job.file = null;
      } catch (error) { job.error = true; job.status = friendlyError(error); }
      renderUploadJobs();
    }
    uploading = false;
    try { if (selectedAlbumId) await refreshAssets(selectedAlbumId); await refreshAlbums(); await renderApp(); }
    catch (error) { setStatus(friendlyError(error), "error"); }
    renderUploadJobs();
  }

  async function uploadFiles(albumId, files) {
    if (publishing) return;
    Array.from(files || []).forEach(function (file) {
      uploadJobs.push({ albumId: String(albumId), file: file, filename: file.name, status: "Waiting", progress: 0 });
    });
    await runUploadJobs();
  }

  function buildUploadZone(album) {
    var zone = el("div", { id: "member-photos-drop-zone", className: "photo-drop-zone", role: "group", "aria-label": "Add photos to " + album.title });
    zone.appendChild(el("h4", { text: "Drop photos here" }));
    zone.appendChild(el("p", { text: "JPEG, PNG or WebP · Up to 50 MB each" }));
    zone.appendChild(el("p", { className: "member-form-hint", text: "Photos are resized automatically. You can keep adding files while a batch uploads." }));
    var input = el("input", { type: "file", id: "member-photos-upload-input", accept: "image/jpeg,image/png,image/webp", multiple: "multiple", className: "sr-only", "aria-label": "Choose photos" });
    input.onchange = function () { var files = Array.from(input.files || []); input.value = ""; void uploadFiles(album.id, files); };
    var choose = el("button", { type: "button", className: "members-events-form-action", text: "Choose photos" });
    choose.disabled = publishing;
    choose.onclick = function () { input.click(); };
    zone.appendChild(input); zone.appendChild(choose);
    var dragDepth = 0;
    function fileDrag(event) { return Array.from(event.dataTransfer ? event.dataTransfer.types : []).includes("Files"); }
    zone.addEventListener("dragenter", function (event) {
      if (!fileDrag(event)) return;
      event.preventDefault(); dragDepth += 1;
      if (!publishing) zone.classList.add("is-dragging");
    });
    zone.addEventListener("dragover", function (event) {
      if (!fileDrag(event)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = publishing ? "none" : "copy";
    });
    zone.addEventListener("dragleave", function (event) {
      if (!fileDrag(event)) return;
      event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) zone.classList.remove("is-dragging");
    });
    zone.addEventListener("drop", function (event) {
      if (!fileDrag(event)) return;
      event.preventDefault(); dragDepth = 0; zone.classList.remove("is-dragging");
      if (publishing) return;
      var files = Array.from(event.dataTransfer.files || []);
      if (!files.length) { setStatus("Drop photo files rather than folders.", "error"); return; }
      void uploadFiles(album.id, files);
    });
    return zone;
  }

  function buildBatchPanel() {
    var panel = el("section", { id: "member-photos-batch", className: "photo-batch-panel", "aria-label": "Upload batch" });
    panel.appendChild(el("h4", { text: "Upload progress" }));
    panel.appendChild(el("p", { id: "member-photos-batch-summary", role: "status" }));
    panel.appendChild(el("progress", { id: "member-photos-batch-progress", max: "100", value: "0", "aria-label": "Batch processing progress" }));
    panel.appendChild(el("span", { id: "member-photos-batch-percent", className: "photo-batch-percent" }));
    panel.appendChild(el("ul", { id: "member-photos-upload-jobs", className: "photo-upload-jobs" }));
    var actions = el("div", { className: "photo-action-row" });
    var retry = el("button", { id: "member-photos-retry-failed", type: "button", className: "members-events-form-action", text: "Retry failed files" });
    retry.onclick = function () {
      uploadJobs.forEach(function (job) { if (job.albumId === selectedAlbumId && job.error) { job.error = false; job.status = "Waiting"; } });
      void runUploadJobs();
    };
    var clear = el("button", { id: "member-photos-clear-completed", type: "button", className: "members-events-form-action", text: "Clear completed files" });
    clear.onclick = function () { uploadJobs = uploadJobs.filter(function (job) { return job.albumId !== selectedAlbumId || !job.done; }); renderUploadJobs(); };
    actions.appendChild(retry); actions.appendChild(clear); panel.appendChild(actions);
    return panel;
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
    appEl.replaceChildren();
    var layout = el("div", { className: "member-photos-layout photo-workspace" });
    var library = el("aside", { className: "photo-album-library", "aria-label": "Your photo albums" });
    library.appendChild(el("h3", { text: "Albums" }));
    var newAlbum = el("button", { type: "button", className: "members-events-form-action", text: "New album" });
    newAlbum.disabled = publishing;
    newAlbum.onclick = function () { selectedAlbumId = null; void renderApp(); };
    library.appendChild(newAlbum);
    if (!albumsCache.length) library.appendChild(el("p", { text: "Create an album to get started." }));
    var list = el("ul", { className: "member-photos-album-list" });
    albumsCache.forEach(function (album) {
      var item = el("li", { className: "member-photos-album-list-item" + (selectedAlbumId === String(album.id) ? " is-active" : "") });
      var button = el("button", { type: "button", className: "photo-album-link", "aria-pressed": String(selectedAlbumId === String(album.id)) });
      button.disabled = publishing;
      button.appendChild(el("strong", { text: album.title || "Untitled album" }));
      var counts = album.assetCounts || {};
      button.appendChild(el("span", { text: (album.published ? "Published" : "Draft") + " · " + (counts.total || 0) + " photos · Order " + (album.sortPosition || 0) }));
      button.onclick = function () {
        selectedAlbumId = String(album.id);
        void refreshAssets(selectedAlbumId).then(renderApp).catch(function (error) { setStatus(friendlyError(error), "error"); });
      };
      item.appendChild(button); list.appendChild(item);
    });
    library.appendChild(list);
    var refresh = el("button", { type: "button", className: "members-events-form-action", text: "Refresh albums" });
    refresh.disabled = publishing;
    refresh.onclick = async function () {
      try { await refreshAlbums(); await loadEventsForLink(); if (selectedAlbumId) await refreshAssets(selectedAlbumId); await renderApp(); }
      catch (error) { setStatus(friendlyError(error), "error"); }
    };
    library.appendChild(refresh);
    if (isAdmin(lastUserRoles)) {
      var maintenance = el("details", { className: "photo-maintenance" });
      maintenance.appendChild(el("summary", { text: "Storage maintenance" }));
      var cleanup = el("button", { type: "button", className: "members-events-form-action", text: "Retry storage cleanup" });
      cleanup.onclick = async function () {
        cleanup.disabled = true;
        try { var result = await window.SNHMemberPortal.photoCleanup(); setStatus(result.cleanup.removed + " objects removed; " + result.cleanup.pending + " queued for retry."); }
        catch (error) { setStatus(friendlyError(error), "error"); }
        finally { cleanup.disabled = false; }
      };
      maintenance.appendChild(cleanup); library.appendChild(maintenance);
    }
    layout.appendChild(library);
    var workspace = el("section", { className: "member-photos-main-col photo-album-workspace" });
    var album = albumsCache.find(function (item) { return String(item.id) === selectedAlbumId; });
    if (!album) {
      workspace.appendChild(el("h3", { text: "Create a photo album" }));
      workspace.appendChild(el("p", { text: "Give it a title, add your photos, and publish when it is ready." }));
      workspace.appendChild(buildAlbumForm(null));
    } else {
      var assets = assetsByAlbum[album.id] || [];
      var header = el("div", { className: "photo-album-heading" });
      var cover = assets.find(function (asset) { return asset.id === album.coverAssetId; }) || assets.find(function (asset) { return pickVariant(asset, "thumb") || pickVariant(asset, "web"); });
      if (cover) {
        var image = el("img", { className: "photo-album-cover-preview", alt: "Cover for " + album.title });
        setPhotoPreview(image, cover); header.appendChild(image);
      }
      var heading = el("div");
      heading.appendChild(el("span", { className: "photo-album-state" + (album.published ? " is-published" : ""), text: album.published ? "Published album" : "Draft album" }));
      heading.appendChild(el("h3", { text: album.title }));
      var ready = assets.filter(function (asset) { return asset.status === "uploaded" || (asset.status === "pending" && asset.hasOriginal); }).length;
      heading.appendChild(el("p", { text: assets.length + " photos · " + ready + " ready to publish" }));
      header.appendChild(heading);
      workspace.appendChild(header);
      var publication = el("div", { className: "photo-publication-bar" });
      var publish = el("button", { id: "member-photos-publish-album", type: "button", className: "members-events-form-action photo-primary-action" });
      publish.dataset.idleLabel = album.published ? "Publish new photos" : "Publish album";
      publish.onclick = function () { void publishAlbum(album); };
      publication.appendChild(publish);
      if (album.published) {
        var view = el("a", { className: "members-events-form-action", href: "photos.html?album=" + encodeURIComponent(album.id), text: "View album" });
        publication.appendChild(view);
        var hide = el("button", { type: "button", className: "members-events-form-action", text: "Hide from gallery" });
        hide.disabled = uploading || publishing;
        hide.onclick = function () { void hideAlbum(album); };
        publication.appendChild(hide);
      }
      workspace.appendChild(publication);
      workspace.appendChild(el("p", { className: "member-form-hint", text: "Publishing makes all ready photos and this album visible together. Choose a cover below before publishing." }));
      var details = el("details", { className: "photo-album-details" });
      details.appendChild(el("summary", { text: "Edit album details" }));
      details.appendChild(buildAlbumForm(album));
      workspace.appendChild(details);
      workspace.appendChild(buildUploadZone(album));
      workspace.appendChild(buildBatchPanel());
      var galleryHeading = el("div", { className: "photo-action-row photo-gallery-heading" });
      galleryHeading.appendChild(el("h4", { text: "Photos and cover" }));
      if (album.coverAssetId) {
        var reset = el("button", { type: "button", className: "members-events-form-action", text: "Use automatic cover" });
        reset.disabled = uploading || publishing;
        reset.onclick = function () { void selectCover(album, null); }; galleryHeading.appendChild(reset);
      }
      workspace.appendChild(galleryHeading);
      if (!assets.length) workspace.appendChild(el("p", { className: "photo-empty-state", text: "No photos yet. Drop a batch above or choose files to add them." }));
      var grid = el("div", { className: "member-photos-grid" });
      assets.forEach(function (asset) { grid.appendChild(buildAssetCard(album, asset)); });
      workspace.appendChild(grid);
    }
    layout.appendChild(workspace);
    appEl.appendChild(layout);
    renderUploadJobs();
    updatePublicationControls();
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
        await loadEventsForLink();
        setStatus("");
      } catch (err) {
        setStatus(friendlyError(err), "error");
      }
    } else {
      try {
        await refreshAlbums();
        await loadEventsForLink();
        if (selectedAlbumId) await refreshAssets(selectedAlbumId);
      } catch (err) {
        setStatus(friendlyError(err), "error");
      }
    }
    await renderApp();
  }

  window.SNHMemberPhotosPanel = { init: init };
})();
