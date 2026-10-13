// Member Photos panel: album list, metadata form, then photos + upload in one column.
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

  function buildAlbumForm(album) {
    var idVal = album ? album.id : "";
    var slugVal = album ? (album.slug || "") : "";
    var titleVal = album ? (album.title || "") : "";
    var descVal = album ? (album.description || "") : "";
    var sortVal = album ? (album.sortPosition != null ? String(album.sortPosition) : "0") : "0";
    var publishedVal = album ? !!album.published : false;
    var includeHighlightsVal = album ? !!album.includeInHighlights : false;

    var form = el("form", { className: "member-photos-album-form members-profile-form" });

    var idInput = el("input", { type: "hidden", id: "member-photos-album-id" });
    idInput.value = idVal;
    form.appendChild(idInput);

    form.appendChild(el("label", { for: "member-photos-album-title", text: "Title" }));
    var titleInput = el("input", { type: "text", id: "member-photos-album-title", maxlength: "200", required: "required" });
    titleInput.value = titleVal;
    titleInput.addEventListener("input",function(){if(!album) slugInput.value=titleInput.value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,80)||"album";});
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

    form.appendChild(el("label", { for: "member-photos-album-event", text: "Linked event (optional)" }));
    form.appendChild(el("p", {
      className: "member-form-hint",
      text: "Only published events are listed. Multiple albums may link to the same event."
    }));
    var eventSelect = el("select", { id: "member-photos-album-event" });
    eventSelect.appendChild(el("option", { value: "", text: "None" }));
    for (var ei = 0; ei < (eventsForLink || []).length; ei += 1) {
      var ev = eventsForLink[ei];
      if (!ev || !ev.id) continue;
      var evLabel = (ev.title || "(untitled)") + (ev.startsAt ? " (" + fmtDate(ev.startsAt) + ")" : "");
      var evOpt = el("option", { value: String(ev.id), text: evLabel });
      if (album && album.eventId && String(album.eventId) === String(ev.id)) evOpt.selected = true;
      eventSelect.appendChild(evOpt);
    }
    form.appendChild(eventSelect);

    form.appendChild(el("label", { for: "member-photos-album-display-at", text: "Display date (optional)" }));
    form.appendChild(el("p", {
      className: "member-form-hint",
      text: "Optional date for sorting or display, especially for albums with no linked event."
    }));
    var displayAtInput = el("input", { type: "datetime-local", id: "member-photos-album-display-at" });
    displayAtInput.value = album && album.displayAt ? toDatetimeLocalValue(album.displayAt) : "";
    form.appendChild(displayAtInput);

    var publishedLabel = el("label", { className: "members-checkbox-label" });
    var publishedInput = el("input", { type: "checkbox", id: "member-photos-album-published", checked: publishedVal });
    publishedLabel.appendChild(publishedInput);
    publishedLabel.appendChild(document.createTextNode(" Published (visible on public gallery)"));
    form.appendChild(publishedLabel);

    var highlightsLabel = el("label", { className: "members-checkbox-label" });
    var highlightsInput = el("input", { type: "checkbox", id: "member-photos-album-include-highlights", checked: includeHighlightsVal });
    highlightsLabel.appendChild(highlightsInput);
    highlightsLabel.appendChild(document.createTextNode(" Include in highlights (Events page photo block)"));
    form.appendChild(highlightsLabel);
    form.appendChild(el("p", {
      className: "member-form-hint",
      text: "If several albums are checked, the public site picks one at random on each load for variety. The album must be published to appear."
    }));

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
          className: "members-events-form-action",
          id: "member-photos-album-delete",
          text: "Delete album"
        });
        actions.appendChild(deleteBtn);
      }
    }
    var advanced=el("details");advanced.appendChild(el("summary",{text:"Album URL and order"}));
    [slugInput,sortInput].forEach(function(input){
      var label=form.querySelector('label[for="'+input.id+'"]');if(label) advanced.appendChild(label);
      advanced.appendChild(input);
    });advanced.appendChild(slugHint);form.insertBefore(advanced,actions.parentNode===form?actions:null);
    form.appendChild(actions);

    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var fields = {
        slug: slugInput.value.trim().toLowerCase(),
        title: titleInput.value.trim(),
        description: descInput.value.trim(),
        sortPosition: Number(sortInput.value || 0) || 0,
        published: publishedInput.checked,
        includeInHighlights: highlightsInput.checked,
        eventId: eventSelect.value ? eventSelect.value : null,
        displayAt: displayAtInput.value ? new Date(displayAtInput.value).toISOString() : null
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

    var coverBtn = el("button", { type: "button", className:"members-events-form-action", text: album.coverAssetId === asset.id ? "Album cover" : "Use as cover" });
    coverBtn.disabled = album.coverAssetId === asset.id;
    coverBtn.addEventListener("click", async function () {
      try {
        await window.SNHMemberPortal.photoAlbumUpsert(album.id, {slug:album.slug,title:album.title,description:album.description,
          sortPosition:album.sortPosition,published:album.published,includeInHighlights:album.includeInHighlights,coverAssetId:asset.id});
        await refreshAlbums(); await renderApp();
      } catch (err) { setStatus(friendlyError(err), "error"); }
    });
    actions.appendChild(coverBtn);
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
    if (!list) return;
    list.replaceChildren();
    var jobs=uploadJobs.filter(function(job){return job.albumId===selectedAlbumId;});
    if(jobs.length) {
      var progress=el("progress",{max:String(jobs.length),value:String(jobs.filter(function(job){return job.done;}).length),"aria-label":"Photo upload progress"});
      list.appendChild(el("li",{text:jobs.filter(function(job){return job.done;}).length+" of "+jobs.length+" photos ready"}));list.lastChild.appendChild(progress);
    }
    uploadJobs.filter(function(job){return job.albumId===selectedAlbumId;}).forEach(function(job){
      var row=el("li",{text:job.filename+": "+job.status});
      if(job.error && !uploading) {
        var retry=el("button",{type:"button",text:"Retry"});
        retry.addEventListener("click",function(){job.error=false;job.status="Waiting";void runUploadJobs();});
        row.appendChild(retry);
      }
      list.appendChild(row);
    });
    var input=document.getElementById("member-photos-upload-input");
    if(input) input.disabled=uploading;
  }
  async function runUploadJobs() {
    if(uploading) return;
    uploading=true;renderUploadJobs();
    for(var job of uploadJobs) {
      if(job.done || job.error) continue;
      try {
        job.onProgress=function(text){job.status=text;renderUploadJobs();};
        var result=await window.SNHMemberPortal.photoUploadAndRegister(job.albumId,job.file,job);
        job.assetId=result.assetId;job.done=true;job.status="Ready to publish";job.file=null;
      } catch(err) {job.error=true;job.status=friendlyError(err);}
      renderUploadJobs();
    }
    uploading=false;
    try { if(selectedAlbumId) await refreshAssets(selectedAlbumId);await refreshAlbums();await renderApp(); }
    catch(err){setStatus(friendlyError(err),"error");}
    renderUploadJobs();
  }
  async function uploadFiles(albumId, files) {
    Array.from(files || []).forEach(function(file){uploadJobs.push({albumId:String(albumId),file:file,filename:file.name,status:"Waiting"});});
    await runUploadJobs();
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
        await loadEventsForLink();
        if (selectedAlbumId) await refreshAssets(selectedAlbumId);
        setStatus("");
        await renderApp();
      } catch (err) {
        setStatus(friendlyError(err), "error");
      }
    });
    topBar.appendChild(refreshBtn);
    if(isAdmin(lastUserRoles)) {
      var cleanupBtn=el("button",{type:"button",className:"members-events-form-action",text:"Retry storage cleanup"});
      cleanupBtn.addEventListener("click",async function(){
        cleanupBtn.disabled=true;
        try {var r=await window.SNHMemberPortal.photoCleanup();setStatus("Cleanup: "+r.cleanup.removed+" objects removed, "+r.cleanup.pending+" queued for retry (some wait for the upload safety window).");}
        catch(err){setStatus(friendlyError(err),"error");}finally{cleanupBtn.disabled=false;}
      });topBar.appendChild(cleanupBtn);
    }
    appEl.appendChild(topBar);

    var layout = el("div", { className: "member-photos-layout" });

    var mainCol = el("section", { className: "member-photos-main-col" });
    mainCol.appendChild(el("h4", { text: "Albums" }));

    if (!albumsCache.length) {
      mainCol.appendChild(el("p", {
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
          (alb.published ? "" : " [draft]") +
          (alb.includeInHighlights ? " · Events page" : "");
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
      mainCol.appendChild(ul);
    }

    mainCol.appendChild(el("h4", { text: "Album editor" }));
    var selectedAlbum = albumsCache.find(function (a) { return String(a.id) === String(selectedAlbumId); }) || null;
    var formBundle = buildAlbumForm(selectedAlbum);
    mainCol.appendChild(formBundle.form);
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

    if (!selectedAlbum) {
      mainCol.appendChild(el("p", {
        className: "member-form-hint member-photos-pick-album-hint",
        text: "Select an album above, or create one in the form, to upload photos."
      }));
    } else {
      var assetsSection = el("div", { className: "member-photos-album-assets" });
      assetsSection.appendChild(el("h4", { text: "Photos in: " + (selectedAlbum.title || selectedAlbum.slug) }));
      assetsSection.appendChild(el("p", {
        className: "member-form-hint",
        text: "Last updated " + fmtDate(selectedAlbum.updatedAt) + " · Slug: " + (selectedAlbum.slug || "(none)") + (selectedAlbum.eventId ? " · Linked event: " + (selectedAlbum.eventTitle || selectedAlbum.eventId) : "")
      }));

      var uploadBlock = el("div", { className: "member-photos-upload-block" });
      var uploadRow = el("div", { className: "member-photos-upload-row" });
      var fileWrap = el("div", { className: "member-photos-upload-file-wrap" });
      fileWrap.appendChild(el("label", { for: "member-photos-upload-input", text: "Add photos (JPEG, PNG or WebP, up to 50 MB):" }));
      var fileInput = el("input", {
        type: "file",
        id: "member-photos-upload-input",
        accept: "image/jpeg,image/png,image/webp",
        multiple: "multiple"
      });
      fileInput.addEventListener("change", function () {
        var files = fileInput.files ? Array.prototype.slice.call(fileInput.files) : [];
        if (files.length === 0) return;
        void uploadFiles(selectedAlbum.id, files).then(function () {
          fileInput.value = "";
        });
      });
      fileWrap.appendChild(fileInput);
      uploadRow.appendChild(fileWrap);
      uploadRow.appendChild(el("p", {
        id: "member-photos-upload-inline-status",
        className: "member-photos-upload-inline-status",
        "aria-live": "polite"
      }));
      uploadBlock.appendChild(uploadRow);
      uploadBlock.appendChild(el("ul", {id:"member-photos-upload-jobs", "aria-live":"polite"}));
      assetsSection.appendChild(uploadBlock);

      var assets = assetsByAlbum[selectedAlbum.id] || [];
      if (!assets.length) {
        assetsSection.appendChild(el("p", {
          className: "member-form-hint",
          text: "No photos in this album yet."
        }));
      } else {
        var grid = el("div", { className: "member-photos-grid" });
        for (var j = 0; j < assets.length; j += 1) {
          grid.appendChild(buildAssetCard(selectedAlbum, assets[j]));
        }
        assetsSection.appendChild(grid);
        var publishAll=el("button",{type:"button",className:"members-events-form-action",text:"Publish ready photos"});
        publishAll.addEventListener("click",async function(){
          publishAll.disabled=true;var failed=0;
          for(var photo of assets.filter(function(a){return a.status==="uploaded" || a.status==="unpublished";})) {
            try {if(photo.uploadMode==="legacy" && !pickVariant(photo,"web")) await window.SNHMemberPortal.photoConvertLegacy(selectedAlbum.id,photo.id);await window.SNHMemberPortal.photoPublishAsset(photo.id,{publish:true});}catch(err){failed++;setStatus(friendlyError(err),"error");}
          }
          await refreshAssets(selectedAlbum.id);await refreshAlbums();await renderApp();
          setStatus(failed?failed+" photo(s) could not be published. Retry individually.":"Photos published. Publish the album above when it is ready.");
        });assetsSection.appendChild(publishAll);
      }
      mainCol.appendChild(assetsSection);
    }

    layout.appendChild(mainCol);
    appEl.appendChild(layout);
    renderUploadJobs();
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
