(function () {
  var GAMES_ROLE_CSV =
    (window.SNHMemberPortal && window.SNHMemberPortal.rolesToCsv && window.SNHMemberPortal.rolesToCsv(
      (window.SNHMemberPortal.ROLE_GROUPS && window.SNHMemberPortal.ROLE_GROUPS.GAMES_ACCESS) ||
        ["games_editor", "games_admin", "club_admin"]
    )) || "games_editor,games_admin,club_admin";

  var appEl = null;
  var statusEl = null;
  var comboboxInputEl = null;
  var comboboxPanelEl = null;
  var comboboxOptionsEl = null;
  var comboboxEmptyEl = null;
  var reviewScaffoldsEl = null;
  var formEl = null;
  var stintsEl = null;
  var saleEl = null;
  var manualWrapEl = null;
  var gamesCache = [];
  var filteredGames = [];
  var currentGameId = null;
  var mode = "idle"; // idle | edit | new
  var isDirty = false;
  var suppressDirtyTracking = false;
  var comboboxOpen = false;
  var comboboxActiveIndex = -1;
  var catalogLoaded = false;
  var inited = false;
  var lastUserRoles = [];
  var comboboxListboxId = "member-games-combobox-listbox";
  var deleteStatusEl = null;
  var deleteNoteInputEl = null;
  var softDeleteBtnEl = null;
  var restoreBtnEl = null;

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "className") n.className = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) n.appendChild(c);
    });
    return n;
  }

  function fieldRow(label, input) {
    var row = el("div", { className: "member-games-field" });
    row.appendChild(el("label", { className: "member-games-label", text: label }));
    row.appendChild(input);
    return row;
  }

  function slugify(value) {
    var out = String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return out;
  }

  function textInput(id, value) {
    var i = el("input", { type: "text", id: id, className: "member-games-input" });
    i.value = value || "";
    return i;
  }

  function textareaInput(id, value) {
    var i = el("textarea", { id: id, className: "member-games-textarea", rows: "5" });
    i.value = value || "";
    return i;
  }

  function numberInput(id, value) {
    var i = el("input", { type: "number", id: id, className: "member-games-input" });
    i.value = value != null && value !== "" ? String(value) : "";
    return i;
  }

  function dateInput(id, value) {
    var i = el("input", { type: "date", id: id, className: "member-games-input" });
    i.value = (value || "").slice(0, 10);
    return i;
  }

  function buildForm() {
    formEl = el("div", { className: "member-games-form", hidden: "hidden", "aria-hidden": "true" });
    formEl.appendChild(
      el("p", {
        className: "member-games-mode-note",
        id: "member-games-mode-note",
        text: ""
      })
    );
    deleteStatusEl = el("p", { className: "member-games-delete-status", id: "mg-delete-status", hidden: "hidden" });
    deleteNoteInputEl = textareaInput("mg-delete-note", "");
    deleteNoteInputEl.setAttribute("rows", "3");
    var deleteNoteRow = fieldRow("Delete note (optional)", deleteNoteInputEl);
    var deleteActions = el("div", { className: "member-games-form-actions", id: "mg-delete-actions" });
    softDeleteBtnEl = el("button", { type: "button", className: "members-sidebar-link", id: "mg-soft-delete" });
    softDeleteBtnEl.textContent = "Soft-delete game";
    restoreBtnEl = el("button", { type: "button", className: "members-sidebar-link", id: "mg-restore" });
    restoreBtnEl.textContent = "Restore game";
    deleteActions.appendChild(softDeleteBtnEl);
    deleteActions.appendChild(restoreBtnEl);
    formEl.appendChild(
      fieldRow(
        "Title",
        textInput("mg-title", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Slug (optional; auto from title if empty)",
        textInput("mg-slug", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Details",
        textareaInput("mg-details", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Image filename",
        textInput("mg-image", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Release date",
        dateInput("mg-release", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Manufacture date",
        dateInput("mg-mfg", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Manufacturer",
        textInput("mg-mfr", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Manufacturer full name",
        textInput("mg-mfrfull", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Type (em|ss|…)",
        textInput("mg-type", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Display",
        textInput("mg-display", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Player count",
        numberInput("mg-players", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Pinside URL",
        textInput("mg-pinside", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "IPDB URL",
        textInput("mg-ipdb", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "Kineticist URL",
        textInput("mg-kineticist", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "OPDB id",
        textInput("mg-opdb", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "OPDB matched via",
        textInput("mg-opdbvia", "")
      )
    );
    formEl.appendChild(
      fieldRow(
        "OPDB canonical name",
        textInput("mg-opdbcanon", "")
      )
    );

    var mapRow = el("p", { className: "member-games-meta" });
    mapRow.appendChild(el("strong", { text: "Map at club (read-only): " }));
    mapRow.appendChild(el("span", { id: "mg-map-at", text: "—" }));
    formEl.appendChild(mapRow);

    manualWrapEl = el("div", { className: "member-games-manual" });
    manualWrapEl.appendChild(el("p", { className: "member-games-help", text: "Manual floor override (when Pinball Map is wrong or missing):" }));
    var manSel = el("select", { id: "mg-manual", className: "member-games-input" });
    ["follow_map", "force_on", "force_off"].forEach(function (v, idx) {
      var opt = el("option", { value: v });
      opt.textContent = ["Follow Pinball Map", "Force on floor", "Force not on floor"][idx];
      manSel.appendChild(opt);
    });
    manualWrapEl.appendChild(fieldRow("Override", manSel));
    manualWrapEl.appendChild(fieldRow("Override note", textInput("mg-manual-note", "")));
    formEl.appendChild(manualWrapEl);

    stintsEl = el("div", { className: "member-games-stints" });
    stintsEl.appendChild(el("h4", { text: "Location stints" }));
    formEl.appendChild(stintsEl);

    saleEl = el("div", { className: "member-games-sale" });
    saleEl.appendChild(el("h4", { text: "For sale listing" }));
    saleEl.appendChild(fieldRow("Status", textInput("mg-sale-status", "draft")));
    saleEl.appendChild(fieldRow("Asking price (cents)", numberInput("mg-sale-cents", "")));
    saleEl.appendChild(fieldRow("Notes", textareaInput("mg-sale-notes", "")));
    formEl.appendChild(saleEl);

    var saveBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-save" });
    saveBtn.textContent = "Save game";
    var cancelBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-cancel" });
    cancelBtn.textContent = "Cancel";
    var actions = el("div", { className: "member-games-form-actions" }, [saveBtn, cancelBtn]);
    formEl.appendChild(actions);
    formEl.appendChild(deleteStatusEl);
    formEl.appendChild(deleteNoteRow);
    formEl.appendChild(deleteActions);

    saveBtn.addEventListener("click", onSaveGame);
    cancelBtn.addEventListener("click", function () {
      if (!confirmDiscardIfDirty()) return;
      enterIdleMode("Canceled new/edit session.");
    });
    formEl.addEventListener("input", onFormPotentiallyDirty);
    formEl.addEventListener("change", onFormPotentiallyDirty);
    softDeleteBtnEl.addEventListener("click", onSoftDeleteGame);
    restoreBtnEl.addEventListener("click", onRestoreGame);

    return formEl;
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function onFormPotentiallyDirty() {
    if (suppressDirtyTracking) return;
    if (mode === "edit" || mode === "new") isDirty = true;
  }

  function getVal(id) {
    var n = document.getElementById(id);
    return n ? String(n.value || "").trim() : "";
  }

  function normalizeGamesForDisplay(list) {
    return (list || []).map(function (g) {
      var out = g || {};
      var baseLabel = out.title || out.slug || out.id || "Untitled game";
      out.__label = isGameDeleted(out) ? baseLabel + " (deleted)" : baseLabel;
      out.__searchTitle = String(out.title || "").toLowerCase();
      return out;
    });
  }

  function currentGame() {
    return gamesCache.find(function (x) {
      return String(x.id) === String(currentGameId);
    });
  }

  function hasDeleteAccess() {
    return !!(
      window.SNHMemberPortal &&
      window.SNHMemberPortal.memberHasAnyRole &&
      window.SNHMemberPortal.memberHasAnyRole(lastUserRoles || [], "games_admin,club_admin")
    );
  }

  function isGameDeleted(game) {
    if (!game) return false;
    var v = game.deletedAt;
    if (v === null || v === undefined) return false;
    var s = String(v).trim().toLowerCase();
    return s !== "" && s !== "null" && s !== "undefined";
  }

  function setButtonVisible(btn, visible) {
    if (!btn) return;
    if (visible) {
      btn.hidden = false;
      btn.style.display = "";
    } else {
      btn.hidden = true;
      btn.style.display = "none";
    }
  }

  function setComboboxOpen(isOpen) {
    comboboxOpen = !!isOpen;
    if (comboboxPanelEl) comboboxPanelEl.hidden = !comboboxOpen;
    if (comboboxInputEl) comboboxInputEl.setAttribute("aria-expanded", comboboxOpen ? "true" : "false");
    if (!comboboxOpen) {
      comboboxActiveIndex = -1;
      if (comboboxInputEl) comboboxInputEl.setAttribute("aria-activedescendant", "");
    }
  }

  function updateActiveDescendant() {
    if (!comboboxInputEl) return;
    if (comboboxActiveIndex < 0 || comboboxActiveIndex >= filteredGames.length) {
      comboboxInputEl.setAttribute("aria-activedescendant", "");
      return;
    }
    var active = filteredGames[comboboxActiveIndex];
    comboboxInputEl.setAttribute("aria-activedescendant", "member-games-option-" + String(active.id));
  }

  function renderComboboxOptions() {
    if (!comboboxOptionsEl || !comboboxEmptyEl) return;
    comboboxOptionsEl.replaceChildren();
    var term = String((comboboxInputEl && comboboxInputEl.value) || "").trim().toLowerCase();
    filteredGames = gamesCache.filter(function (g) {
      return !term || g.__searchTitle.indexOf(term) !== -1;
    });
    filteredGames.forEach(function (g, idx) {
      var opt = el("button", {
        type: "button",
        className: "member-games-option",
        role: "option",
        id: "member-games-option-" + String(g.id),
        "aria-selected": comboboxActiveIndex === idx ? "true" : "false"
      });
      opt.textContent = g.__label;
      opt.addEventListener("click", function () {
        onGameSelected(g.id);
      });
      comboboxOptionsEl.appendChild(opt);
    });
    if (comboboxActiveIndex >= filteredGames.length) comboboxActiveIndex = filteredGames.length - 1;
    if (comboboxActiveIndex < -1) comboboxActiveIndex = -1;
    updateActiveDescendant();
    refreshComboboxActiveStyles();
    comboboxEmptyEl.hidden = filteredGames.length > 0;
  }

  function refreshComboboxActiveStyles() {
    if (!comboboxOptionsEl) return;
    var buttons = comboboxOptionsEl.querySelectorAll(".member-games-option");
    buttons.forEach(function (btn, idx) {
      var active = idx === comboboxActiveIndex;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function populateCombobox() {
    gamesCache = normalizeGamesForDisplay(gamesCache);
    renderComboboxOptions();
  }

  function setMode(nextMode) {
    mode = nextMode;
    var isIdle = mode === "idle";
    formEl.hidden = isIdle;
    formEl.setAttribute("aria-hidden", isIdle ? "true" : "false");
    if (reviewScaffoldsEl) reviewScaffoldsEl.hidden = !isIdle;
    var modeNote = document.getElementById("member-games-mode-note");
    if (modeNote) {
      modeNote.textContent =
        mode === "new"
          ? 'Creating game manually (secondary path). Prefer Pinball Map for standard machine additions.'
          : "";
    }
    if (manualWrapEl) manualWrapEl.hidden = mode !== "edit";
    if (saleEl) saleEl.hidden = mode !== "edit";
    if (stintsEl) stintsEl.hidden = mode !== "edit";
    if (deleteStatusEl) deleteStatusEl.hidden = mode !== "edit";
    var deleteNoteRow = deleteNoteInputEl ? deleteNoteInputEl.closest(".member-games-field") : null;
    if (deleteNoteRow) deleteNoteRow.hidden = mode !== "edit";
    var deleteActions = document.getElementById("mg-delete-actions");
    if (deleteActions) deleteActions.hidden = mode !== "edit";
  }

  function focusFirstFormField() {
    var title = document.getElementById("mg-title");
    if (title) title.focus();
  }

  function clearFormForNewGame() {
    suppressDirtyTracking = true;
    [
      "mg-title",
      "mg-slug",
      "mg-details",
      "mg-image",
      "mg-release",
      "mg-mfg",
      "mg-mfr",
      "mg-mfrfull",
      "mg-type",
      "mg-display",
      "mg-players",
      "mg-pinside",
      "mg-ipdb",
      "mg-kineticist",
      "mg-opdb",
      "mg-opdbvia",
      "mg-opdbcanon",
      "mg-manual-note",
      "mg-sale-cents",
      "mg-sale-notes"
    ].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.value = "";
    });
    var mapAt = document.getElementById("mg-map-at");
    if (mapAt) mapAt.textContent = "—";
    var man = document.getElementById("mg-manual");
    if (man) man.value = "follow_map";
    var saleStatus = document.getElementById("mg-sale-status");
    if (saleStatus) saleStatus.value = "draft";
    renderStints([]);
    suppressDirtyTracking = false;
  }

  function confirmDiscardIfDirty() {
    if (!isDirty) return true;
    return window.confirm("Discard unsaved changes?");
  }

  function enterIdleMode(statusMessage) {
    currentGameId = null;
    isDirty = false;
    setMode("idle");
    if (comboboxInputEl) {
      comboboxInputEl.value = "";
      comboboxInputEl.focus();
    }
    setComboboxOpen(false);
    renderComboboxOptions();
    if (statusMessage) setStatus(statusMessage);
  }

  function onGameSelected(gameId) {
    if (!confirmDiscardIfDirty()) return;
    populateForm(gameId);
    setComboboxOpen(false);
  }

  function beginNewGameMode() {
    if (!confirmDiscardIfDirty()) return;
    currentGameId = null;
    setMode("new");
    clearFormForNewGame();
    isDirty = false;
    setStatus('Creating new game. Use "Save game" to create a manual entry.');
    focusFirstFormField();
  }

  function buildPicker() {
    var wrap = el("div", { className: "member-games-picker" });
    wrap.appendChild(
      el("p", {
        className: "member-games-help",
        text: "Preferred: add new machines through Pinball Map at the SNHPC location. This keeps ingest and lineup history aligned."
      })
    );
    wrap.appendChild(
      el("p", {
        className: "member-games-help",
        text: "After adding on Pinball Map, wait for the scheduled ingest or run a manual ingest refresh."
      })
    );
    wrap.appendChild(
      el("p", {
        className: "member-games-help",
        text: 'Use "New Game" here only for entries that Pinball Map does not cover (for example prototypes, private/offline records, or non-standard catalog items).'
      })
    );
    var row = el("div", { className: "member-games-picker-row" });
    var comboWrap = el("div", { className: "member-games-combobox" });
    comboboxInputEl = el("input", {
      type: "text",
      id: "member-games-combobox-input",
      className: "member-games-input member-games-combobox-input",
      role: "combobox",
      "aria-expanded": "false",
      "aria-controls": comboboxListboxId,
      "aria-autocomplete": "list",
      autocomplete: "off",
      placeholder: "Loading games catalog…",
      disabled: "disabled"
    });
    comboboxPanelEl = el("div", { className: "member-games-combobox-panel", hidden: "hidden" });
    comboboxOptionsEl = el("div", { className: "member-games-options", id: comboboxListboxId, role: "listbox" });
    var pinnedAction = el("button", { type: "button", className: "member-games-option member-games-option--new" });
    pinnedAction.textContent = "+ New game";
    pinnedAction.addEventListener("click", function () {
      beginNewGameMode();
      setComboboxOpen(false);
    });
    comboboxEmptyEl = el("div", { className: "member-games-empty", hidden: "hidden" });
    comboboxEmptyEl.appendChild(el("p", { text: "No games match that title search yet." }));
    comboboxEmptyEl.appendChild(el("p", { text: "You can refine your search or create a new manual entry." }));
    var emptyNew = el("button", { type: "button", className: "members-sidebar-link" });
    emptyNew.textContent = "+ New Game";
    emptyNew.addEventListener("click", function () {
      beginNewGameMode();
      setComboboxOpen(false);
    });
    comboboxEmptyEl.appendChild(emptyNew);
    comboboxPanelEl.appendChild(comboboxOptionsEl);
    comboboxPanelEl.appendChild(pinnedAction);
    comboboxPanelEl.appendChild(comboboxEmptyEl);
    comboWrap.appendChild(comboboxInputEl);
    comboWrap.appendChild(comboboxPanelEl);
    row.appendChild(comboWrap);
    wrap.appendChild(row);
    comboboxInputEl.addEventListener("focus", function () {
      if (!catalogLoaded) return;
      setComboboxOpen(true);
      renderComboboxOptions();
    });
    comboboxInputEl.addEventListener("click", function () {
      if (!catalogLoaded) return;
      setComboboxOpen(true);
      renderComboboxOptions();
    });
    comboboxInputEl.addEventListener("input", function () {
      if (!catalogLoaded) return;
      setComboboxOpen(true);
      comboboxActiveIndex = -1;
      renderComboboxOptions();
    });
    comboboxInputEl.addEventListener("keydown", function (evt) {
      if (evt.key === "ArrowDown") {
        evt.preventDefault();
        if (!comboboxOpen) setComboboxOpen(true);
        if (filteredGames.length) {
          comboboxActiveIndex = Math.min(filteredGames.length - 1, comboboxActiveIndex + 1);
          refreshComboboxActiveStyles();
          updateActiveDescendant();
        }
      } else if (evt.key === "ArrowUp") {
        evt.preventDefault();
        if (!comboboxOpen) setComboboxOpen(true);
        if (filteredGames.length) {
          comboboxActiveIndex = Math.max(0, comboboxActiveIndex - 1);
          refreshComboboxActiveStyles();
          updateActiveDescendant();
        }
      } else if (evt.key === "Enter") {
        if (!comboboxOpen) return;
        evt.preventDefault();
        if (comboboxActiveIndex >= 0 && comboboxActiveIndex < filteredGames.length) {
          onGameSelected(filteredGames[comboboxActiveIndex].id);
        } else if (!filteredGames.length) {
          beginNewGameMode();
          setComboboxOpen(false);
        }
      } else if (evt.key === "Escape") {
        if (comboboxOpen) {
          evt.preventDefault();
          setComboboxOpen(false);
          comboboxInputEl.focus();
        }
      }
    });
    document.addEventListener("click", function (evt) {
      if (!appEl || !comboboxOpen) return;
      var inCombo = comboWrap.contains(evt.target);
      if (!inCombo) setComboboxOpen(false);
    });
    return wrap;
  }

  function buildReviewScaffolds() {
    reviewScaffoldsEl = el("div", { className: "member-games-review-scaffolds" });
    var missing = el("section", { className: "member-games-review-card" });
    missing.appendChild(el("h4", { text: "Missing game data" }));
    missing.appendChild(
      el("p", {
        text: "Review games that are missing key metadata (image, year, manufacturer, or links) and queue updates."
      })
    );
    missing.appendChild(el("p", { className: "member-games-review-todo", text: "TODO: add quality checks and review queue." }));
    var malfunction = el("section", { className: "member-games-review-card" });
    malfunction.appendChild(el("h4", { text: "Game malfunction reports" }));
    malfunction.appendChild(
      el("p", {
        text: "Track machine issues and status notes for follow-up repair and lineup visibility decisions."
      })
    );
    malfunction.appendChild(el("p", { className: "member-games-review-todo", text: "TODO: connect issue reporting workflow." }));
    reviewScaffoldsEl.appendChild(missing);
    reviewScaffoldsEl.appendChild(malfunction);
    return reviewScaffoldsEl;
  }

  function renderStints(stints) {
    if (!stintsEl) return;
    stintsEl.querySelectorAll(".member-games-stint-row, #mg-add-stint").forEach(function (n) {
      n.remove();
    });
    (stints || []).forEach(function (s, idx) {
      var row = el("div", { className: "member-games-stint-row" });
      row.appendChild(el("span", { className: "member-games-stint-title", text: "Stint " + (idx + 1) }));
      var id = s.id || "";
      var addr = el("input", { type: "text", className: "member-games-input mg-st-addr", "data-stint-id": id, placeholder: "Address" });
      addr.value = s.address || "";
      var loc = el("input", { type: "number", className: "member-games-input mg-st-loc", "data-stint-id": id, placeholder: "Pinball Map location id" });
      loc.value = s.pinballMapLocationId != null ? String(s.pinballMapLocationId) : "";
      var mid = el("input", { type: "number", className: "member-games-input mg-st-mid", "data-stint-id": id, placeholder: "Machine id" });
      mid.value = s.pinballMapMachineId != null ? String(s.pinballMapMachineId) : "";
      var jn = el("input", { type: "date", className: "member-games-input mg-st-join", "data-stint-id": id });
      jn.value = (s.joinedClubDate || "").slice(0, 10);
      var lv = el("input", { type: "date", className: "member-games-input mg-st-leave", "data-stint-id": id });
      lv.value = (s.leftClubDate || "").slice(0, 10);
      row.appendChild(addr);
      row.appendChild(loc);
      row.appendChild(mid);
      row.appendChild(jn);
      row.appendChild(lv);
      var saveSt = el("button", { type: "button", className: "members-sidebar-link" });
      saveSt.textContent = "Save stint";
      saveSt.addEventListener("click", function () {
        onSaveStint(id, addr.value, loc.value, mid.value, jn.value, lv.value);
      });
      row.appendChild(saveSt);
      if (window.SNHMemberPortal && window.SNHMemberPortal.memberHasAnyRole && window.SNHMemberPortal.memberHasAnyRole(lastUserRoles || [], "games_admin,club_admin")) {
        var delSt = el("button", { type: "button", className: "members-sidebar-link" });
        delSt.textContent = "Delete";
        delSt.addEventListener("click", function () {
          if (!id || !confirm("Delete this stint?")) return;
          onDeleteStint(id);
        });
        row.appendChild(delSt);
      }
      stintsEl.appendChild(row);
    });
    var addBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-add-stint" });
    addBtn.textContent = "Add stint";
    addBtn.addEventListener("click", onAddStint);
    stintsEl.appendChild(addBtn);
  }

  async function loadSale(gameId) {
    if (!window.SNHMemberPortal || !window.SNHMemberPortal.gamesGetSaleListing) return;
    try {
      var row = await window.SNHMemberPortal.gamesGetSaleListing(gameId);
      var s = document.getElementById("mg-sale-status");
      var c = document.getElementById("mg-sale-cents");
      var n = document.getElementById("mg-sale-notes");
      if (row == null || row === "null") {
        if (s) s.value = "draft";
        if (c) c.value = "";
        if (n) n.value = "";
        return;
      }
      var r = typeof row === "string" ? JSON.parse(row) : row;
      if (!r || !r.status) {
        if (s) s.value = "draft";
        if (c) c.value = "";
        if (n) n.value = "";
        return;
      }
      if (s) s.value = r.status || "draft";
      if (c) c.value = r.asking_price_cents != null ? String(r.asking_price_cents) : "";
      if (n) n.value = r.notes || "";
    } catch (e) {
      console.warn("sale listing", e);
    }
  }

  async function populateForm(gameId) {
    currentGameId = gameId;
    var g = currentGame();
    if (!g) return;
    if (comboboxInputEl) comboboxInputEl.value = g.__label || g.title || g.slug || "";
    setMode("edit");
    suppressDirtyTracking = true;
    document.getElementById("mg-title").value = g.title || "";
    document.getElementById("mg-slug").value = g.slug || "";
    document.getElementById("mg-details").value = g.details || "";
    document.getElementById("mg-image").value = g.imageFilename || "";
    document.getElementById("mg-release").value = (g.releaseDate || "").slice(0, 10);
    document.getElementById("mg-mfg").value = (g.manufactureDate || "").slice(0, 10);
    document.getElementById("mg-mfr").value = g.manufacturer || "";
    document.getElementById("mg-mfrfull").value = g.manufacturerFullName || "";
    document.getElementById("mg-type").value = g.type || "";
    document.getElementById("mg-display").value = g.display || "";
    document.getElementById("mg-players").value = g.playerCount != null ? String(g.playerCount) : "";
    document.getElementById("mg-pinside").value = g.pinsideUrl || "";
    document.getElementById("mg-ipdb").value = g.ipdbUrl || "";
    document.getElementById("mg-kineticist").value = g.kineticistUrl || "";
    document.getElementById("mg-opdb").value = g.opdbId || "";
    document.getElementById("mg-opdbvia").value = g.opdbMatchedVia || "";
    document.getElementById("mg-opdbcanon").value = g.opdbCanonicalName || "";
    document.getElementById("mg-map-at").textContent =
      g.mapAtClub === true ? "true" : g.mapAtClub === false ? "false" : "—";
    var man = document.getElementById("mg-manual");
    if (man) {
      if (g.manualAtClubOverride === true) man.value = "force_on";
      else if (g.manualAtClubOverride === false) man.value = "force_off";
      else man.value = "follow_map";
    }
    document.getElementById("mg-manual-note").value = g.manualAtClubNote || "";
    if (deleteStatusEl) {
      deleteStatusEl.hidden = false;
      deleteStatusEl.textContent = isGameDeleted(g)
        ? "This game is soft-deleted and hidden from the public catalog."
        : "This game is active in the editor and public catalog.";
    }
    if (deleteNoteInputEl) {
      deleteNoteInputEl.value = g.deleteNote || "";
    }
    var canDelete = hasDeleteAccess();
    var deleted = isGameDeleted(g);
    setButtonVisible(softDeleteBtnEl, canDelete && !deleted);
    setButtonVisible(restoreBtnEl, canDelete && deleted);
    renderStints(g.locationStints || []);
    suppressDirtyTracking = false;
    await loadSale(gameId);
    isDirty = false;
    setStatus("Editing " + (g.title || g.slug || g.id) + ".");
    focusFirstFormField();
  }

  async function onSaveGame() {
    if (!window.SNHMemberPortal) return;
    var title = getVal("mg-title");
    if (!title) {
      setStatus("Title is required.");
      return;
    }
    setStatus("Saving…");
    try {
      var rd = getVal("mg-release");
      var md = getVal("mg-mfg");
      var fields = {
        title: getVal("mg-title"),
        slug: getVal("mg-slug") || undefined,
        details: getVal("mg-details"),
        imageFilename: getVal("mg-image") || null,
        releaseDate: rd ? rd : null,
        manufactureDate: md ? md : null,
        manufacturer: getVal("mg-mfr") || null,
        manufacturerFullName: getVal("mg-mfrfull") || null,
        type: getVal("mg-type") || null,
        display: getVal("mg-display") || null,
        playerCount: getVal("mg-players") ? Number(getVal("mg-players")) : null,
        pinsideUrl: getVal("mg-pinside") || null,
        ipdbUrl: getVal("mg-ipdb") || null,
        kineticistUrl: getVal("mg-kineticist") || null,
        opdbId: getVal("mg-opdb") || null,
        opdbMatchedVia: getVal("mg-opdbvia") || null,
        opdbCanonicalName: getVal("mg-opdbcanon") || null
      };
      var savedGameId = currentGameId;
      if (mode === "new") {
        fields.slug = getVal("mg-slug") || slugify(title);
        savedGameId = await window.SNHMemberPortal.gamesCreate(fields);
      } else {
        if (!savedGameId) {
          setStatus("Select a game first.");
          return;
        }
        var editingGame = currentGame();
        if (editingGame && isGameDeleted(editingGame)) {
          setStatus("Restore this game before saving metadata changes.");
          return;
        }
        await window.SNHMemberPortal.gamesUpsert(savedGameId, fields);
      }

      if (mode === "edit") {
        var m = document.getElementById("mg-manual");
        var mv = m ? m.value : "follow_map";
        if (mv === "follow_map") {
          await window.SNHMemberPortal.gamesClearManualAtClub(savedGameId);
        } else if (mv === "force_on") {
          await window.SNHMemberPortal.gamesSetManualAtClub(savedGameId, true, getVal("mg-manual-note") || null);
        } else {
          await window.SNHMemberPortal.gamesSetManualAtClub(savedGameId, false, getVal("mg-manual-note") || null);
        }

        await window.SNHMemberPortal.gamesSetSaleListing(savedGameId, {
          status: getVal("mg-sale-status") || "draft",
          asking_price_cents: getVal("mg-sale-cents") ? Number(getVal("mg-sale-cents")) : null,
          notes: getVal("mg-sale-notes") || null
        });
      }

      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      populateCombobox();
      comboboxInputEl.value = "";
      await populateForm(savedGameId);
      currentGameId = savedGameId;
      setMode("edit");
      setComboboxOpen(false);
      renderComboboxOptions();
      isDirty = false;
      setStatus("Saved.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function onSaveStint(stintId, address, loc, mid, join, leave) {
    if (!currentGameId) return;
    setStatus("Saving stint…");
    try {
      var payload = {
        id: stintId || undefined,
        address: address,
        pinballMapLocationId: loc ? Number(loc) : null,
        pinballMapMachineId: mid ? Number(mid) : null,
        joinedClubDate: join || null,
        leftClubDate: leave || null,
        dateUnknown: !join && !leave
      };
      await window.SNHMemberPortal.gamesUpsertStint(currentGameId, payload);
      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      var g = gamesCache.find(function (x) {
        return String(x.id) === String(currentGameId);
      });
      if (g) renderStints(g.locationStints || []);
      setStatus("Stint saved.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function onAddStint() {
    if (!currentGameId) return;
    await onSaveStint("", "134 Haines Street, Nashua, NH", "8908", "", "", "");
  }

  async function onDeleteStint(stintId) {
    try {
      await window.SNHMemberPortal.gamesDeleteStint(stintId);
      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      var g = gamesCache.find(function (x) {
        return String(x.id) === String(currentGameId);
      });
      if (g) renderStints(g.locationStints || []);
      setStatus("Stint deleted.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function onSoftDeleteGame() {
    if (!currentGameId || !window.SNHMemberPortal || !window.SNHMemberPortal.gamesSoftDelete) return;
    var game = currentGame();
    if (!game || isGameDeleted(game)) return;
    if (!window.confirm("Soft-delete this game? It will be hidden from the public catalog.")) return;
    setStatus("Soft-deleting game…");
    try {
      await window.SNHMemberPortal.gamesSoftDelete(currentGameId, getVal("mg-delete-note") || null);
      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      populateCombobox();
      await populateForm(currentGameId);
      isDirty = false;
      setStatus("Game soft-deleted.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function onRestoreGame() {
    if (!currentGameId || !window.SNHMemberPortal || !window.SNHMemberPortal.gamesRestore) return;
    var game = currentGame();
    if (!game || !isGameDeleted(game)) return;
    setStatus("Restoring game…");
    try {
      await window.SNHMemberPortal.gamesRestore(currentGameId);
      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      populateCombobox();
      await populateForm(currentGameId);
      isDirty = false;
      setStatus("Game restored.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function loadCatalog() {
    setStatus("Loading games catalog…");
    try {
      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      catalogLoaded = true;
      populateCombobox();
      if (comboboxInputEl) {
        comboboxInputEl.removeAttribute("disabled");
        comboboxInputEl.placeholder = "Search by title to edit an existing game…";
        if (document.activeElement === comboboxInputEl) {
          setComboboxOpen(true);
          renderComboboxOptions();
        }
      }
      enterIdleMode("Loaded " + gamesCache.length + " games.");
    } catch (err) {
      catalogLoaded = false;
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  function buildShell() {
    appEl = document.getElementById("member-games-app");
    if (!appEl) return;
    appEl.replaceChildren();
    statusEl = el("p", {
      className: "member-games-status",
      id: "member-games-status",
      role: "status",
      "aria-live": "polite"
    });
    appEl.appendChild(statusEl);
    appEl.appendChild(buildPicker());
    appEl.appendChild(buildReviewScaffolds());
    appEl.appendChild(buildForm());
    setMode("idle");
  }

  function onPanelShown(userRoles) {
    lastUserRoles = userRoles || [];
    if (!window.SNHMemberPortal || !window.SNHMemberPortal.memberHasAnyRole(userRoles || [], GAMES_ROLE_CSV)) {
      return;
    }
    if (!inited) {
      inited = true;
      buildShell();
      loadCatalog();
    }
  }

  window.SNHMemberGamesPanel = {
    onPanelShown: onPanelShown
  };
})();
