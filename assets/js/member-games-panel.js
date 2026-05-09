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
  var atClubOnlyToggleEl = null;
  var reviewScaffoldsEl = null;
  var formEl = null;
  var stintsSectionEl = null;
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
  var catalogLoadPromise = null;
  var inited = false;
  var lastUserRoles = [];
  var comboboxListboxId = "member-games-combobox-listbox";
  var deleteStatusEl = null;
  var deleteNoteInputEl = null;
  var softDeleteBtnEl = null;
  var restoreBtnEl = null;
  var highScoresWrapEl = null;
  var modsWrapEl = null;
  var pingolfTargetsWrapEl = null;
  var pingolfAdminEl = null;
  var featuredPingolfSessionId = null;
  var partiesCache = [];
  var filteredParties = [];
  var partyComboboxOpen = false;
  var partyComboboxActiveIndex = -1;
  var partyComboboxInputEl = null;
  var partyComboboxPanelEl = null;
  var partyComboboxOptionsEl = null;
  var partyComboboxEmptyEl = null;
  var partyComboWrapEl = null;
  var partiesBlockEl = null;
  var gameComboWrapEl = null;
  var partyComboboxListboxId = "member-parties-combobox-listbox";
  var editingPartyId = null;
  var partyFieldsWrapEl = null;
  var partyEditMode = "idle"; // idle | new | edit
  var partyFormDirty = false;
  var partyLinkWrapEl = null;
  var aiWrapEl = null;
  var aiStatusEl = null;
  var aiProposalBodyEl = null;
  var aiProposalData = null;
  var aiDescriptionRegenCount = 0;
  var aiImageRegenCount = 0;
  var aiBusy = false;
  var filterAtClubOnly = false;

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

  /** Collapsible panel; closed by default. Summary doubles as section heading. */
  function wrapCollapsible(summaryText, panelEl, extraDetailClass) {
    var det = el("details", {
      className: "member-games-collapsible" + (extraDetailClass ? " " + extraDetailClass : "")
    });
    det.appendChild(el("summary", { className: "member-games-collapsible-summary", text: summaryText }));
    det.appendChild(panelEl);
    return det;
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

  function formatHighScoreDisplay(score) {
    if (score == null) return "";
    var n = Number(score);
    if (Number.isNaN(n)) return String(score);
    return n.toLocaleString(undefined);
  }

  function parseScoreFieldRaw(str) {
    return String(str || "")
      .replace(/,/g, "")
      .replace(/[^\d]/g, "")
      .trim();
  }

  function wireHighScoreScoreField(input) {
    input.setAttribute("inputmode", "numeric");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.addEventListener("focus", function () {
      input.value = parseScoreFieldRaw(input.value);
    });
    input.addEventListener("blur", function () {
      var raw = parseScoreFieldRaw(input.value);
      if (!raw) return;
      var n = Number(raw);
      if (Number.isNaN(n)) return;
      input.value = formatHighScoreDisplay(n);
    });
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
    formEl.appendChild(
      el("h3", {
        className: "member-games-section-heading",
        id: "mg-section-game",
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

    formEl.appendChild(buildReviewScaffolds());

    stintsEl = el("div", { className: "member-games-stints member-games-collapsible-panel" });
    stintsSectionEl = wrapCollapsible("Location stints", stintsEl);
    formEl.appendChild(stintsSectionEl);

    var salePanel = el("div", { className: "member-games-sale member-games-collapsible-panel" });
    salePanel.appendChild(fieldRow("Status", textInput("mg-sale-status", "draft")));
    salePanel.appendChild(fieldRow("Asking price (cents)", numberInput("mg-sale-cents", "")));
    salePanel.appendChild(fieldRow("Notes", textareaInput("mg-sale-notes", "")));
    saleEl = wrapCollapsible("For sale listing", salePanel);
    formEl.appendChild(saleEl);

    appendPartyGameLinkSection();

    var hsPanel = el("div", { className: "member-games-extended member-games-collapsible-panel", id: "mg-high-scores-wrap" });
    hsPanel.appendChild(el("div", { id: "mg-high-scores-list", className: "member-games-sublist" }));
    hsPanel.appendChild(
      el("p", { className: "member-games-help", text: "Shown when visitors open More Info on games.html." })
    );
    var hsScoreInput = el("input", { type: "text", id: "mg-hs-score", className: "member-games-input" });
    wireHighScoreScoreField(hsScoreInput);
    hsPanel.appendChild(fieldRow("Score", hsScoreInput));
    hsPanel.appendChild(fieldRow("Initials / label", textInput("mg-hs-player", "")));
    hsPanel.appendChild(fieldRow("Achieved on", dateInput("mg-hs-date", "")));
    hsPanel.appendChild(fieldRow("Notes", textInput("mg-hs-notes", "")));
    var hsAdd = el("button", { type: "button", className: "members-sidebar-link", id: "mg-hs-add" });
    hsAdd.textContent = "Add high score";
    hsAdd.addEventListener("click", onAddHighScore);
    hsPanel.appendChild(hsAdd);
    highScoresWrapEl = wrapCollapsible("High scores (public More Info)", hsPanel);
    formEl.appendChild(highScoresWrapEl);

    var modsPanel = el("div", { className: "member-games-extended member-games-collapsible-panel", id: "mg-mods-wrap" });
    modsPanel.appendChild(el("div", { id: "mg-mods-list", className: "member-games-sublist" }));
    modsPanel.appendChild(fieldRow("Title", textInput("mg-mod-title", "")));
    modsPanel.appendChild(fieldRow("Description", textInput("mg-mod-desc", "")));
    modsPanel.appendChild(fieldRow("Reference URL", textInput("mg-mod-url", "")));
    var modAdd = el("button", { type: "button", className: "members-sidebar-link", id: "mg-mod-add" });
    modAdd.textContent = "Add mod";
    modAdd.addEventListener("click", onAddMod);
    modsPanel.appendChild(modAdd);
    modsWrapEl = wrapCollapsible("Custom mods (public More Info)", modsPanel);
    formEl.appendChild(modsWrapEl);

    var pingolfPanel = el("div", { className: "member-games-extended member-games-collapsible-panel", id: "mg-pingolf-targets-wrap" });
    pingolfPanel.appendChild(el("p", { className: "member-games-help", id: "mg-pingolf-help", text: "" }));
    pingolfPanel.appendChild(el("div", { id: "mg-pingolf-target-list", className: "member-games-sublist" }));
    pingolfPanel.appendChild(fieldRow("Target description", textInput("mg-pg-desc", "")));
    pingolfPanel.appendChild(fieldRow("Target value (optional)", numberInput("mg-pg-val", "")));
    var pgAdd = el("button", { type: "button", className: "members-sidebar-link", id: "mg-pg-add" });
    pgAdd.textContent = "Add Pingolf target";
    pgAdd.addEventListener("click", onAddPingolfTarget);
    pingolfPanel.appendChild(pgAdd);
    pingolfTargetsWrapEl = wrapCollapsible("Pingolf target (featured session)", pingolfPanel);
    formEl.appendChild(pingolfTargetsWrapEl);

    var pingolfAdminPanel = el("div", { className: "member-games-pingolf-admin member-games-collapsible-panel", id: "mg-pingolf-admin-wrap" });
    pingolfAdminPanel.appendChild(
      el("p", {
        className: "member-games-help",
        text: "Only one featured session at a time; it drives public Pingolf targets in More Info on games.html."
      })
    );
    pingolfAdminPanel.appendChild(el("ul", { className: "mg-pingolf-session-ul member-games-help" }));
    pingolfAdminPanel.appendChild(fieldRow("New session title", textInput("mg-pg-admin-title", "")));
    var featRow = el("div", { className: "member-games-field member-games-checkbox-row" });
    var featCb = el("input", { type: "checkbox", id: "mg-pg-admin-featured" });
    featRow.appendChild(featCb);
    featRow.appendChild(el("label", { for: "mg-pg-admin-featured", text: "Featured session" }));
    pingolfAdminPanel.appendChild(featRow);
    pingolfAdminPanel.appendChild(fieldRow("Session notes", textInput("mg-pg-admin-notes", "")));
    var pgSessBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-pg-admin-save" });
    pgSessBtn.textContent = "Save Pingolf session";
    pgSessBtn.addEventListener("click", onCreatePingolfSession);
    pingolfAdminPanel.appendChild(pgSessBtn);
    pingolfAdminEl = wrapCollapsible("Pingolf sessions (games admin)", pingolfAdminPanel);
    formEl.appendChild(pingolfAdminEl);

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

  function isValidHttpUrl(value) {
    var v = String(value || "").trim();
    if (!v) return true;
    try {
      var u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  function fmtConfidence(score) {
    if (typeof score !== "number" || Number.isNaN(score)) return "0%";
    return Math.round(score * 100) + "%";
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

  function normalizePartiesForDisplay(list) {
    return (list || []).map(function (p) {
      var out = p || {};
      var full = String(out.fullName || "").trim();
      var disp = String(out.displayName || "").trim();
      var fallback = full || disp || String(out.id || "Untitled party");
      var bits = "";
      if (full && disp) bits = disp === full ? full : full + " · " + disp;
      else bits = fallback;
      if (bits.length > 92) bits = bits.slice(0, 89) + "…";
      out.__label = bits;
      out.__search = (full + " " + disp + " " + String(out.contactEmail || "")).trim().toLowerCase();
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

  function isGameAtClubToday(game) {
    if (!game || typeof game !== "object") return false;
    if (game.manualAtClubOverride === true) return true;
    if (game.manualAtClubOverride === false) return false;
    if (game.mapAtClub === true) return true;
    if (game.mapAtClub === false) return false;
    return game.atClub === true;
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
      if (filterAtClubOnly && !isGameAtClubToday(g)) return false;
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
    if (!filteredGames.length) {
      comboboxEmptyEl.replaceChildren();
      if (filterAtClubOnly) {
        comboboxEmptyEl.appendChild(el("p", { text: "No games are currently marked as at club." }));
        comboboxEmptyEl.appendChild(
          el("p", { text: "Clear the checkbox to browse the full catalog, including off-floor and archived entries." })
        );
      } else {
        comboboxEmptyEl.appendChild(el("p", { text: "No games match that title search yet." }));
        comboboxEmptyEl.appendChild(el("p", { text: "You can refine your search or create a new manual entry." }));
      }
      var emptyNew = el("button", { type: "button", className: "members-sidebar-link" });
      emptyNew.textContent = "+ New Game";
      emptyNew.addEventListener("click", function () {
        beginNewGameMode();
        setComboboxOpen(false);
      });
      comboboxEmptyEl.appendChild(emptyNew);
    }
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
    if (atClubOnlyToggleEl) atClubOnlyToggleEl.checked = !!filterAtClubOnly;
    renderComboboxOptions();
  }

  function setPartyComboboxOpen(isOpen) {
    partyComboboxOpen = !!isOpen;
    if (partyComboboxPanelEl) partyComboboxPanelEl.hidden = !partyComboboxOpen;
    if (partyComboboxInputEl) {
      partyComboboxInputEl.setAttribute("aria-expanded", partyComboboxOpen ? "true" : "false");
    }
    if (!partyComboboxOpen) {
      partyComboboxActiveIndex = -1;
      if (partyComboboxInputEl) partyComboboxInputEl.setAttribute("aria-activedescendant", "");
    }
  }

  function updatePartyActiveDescendant() {
    if (!partyComboboxInputEl) return;
    if (partyComboboxActiveIndex < 0 || partyComboboxActiveIndex >= filteredParties.length) {
      partyComboboxInputEl.setAttribute("aria-activedescendant", "");
      return;
    }
    var active = filteredParties[partyComboboxActiveIndex];
    partyComboboxInputEl.setAttribute("aria-activedescendant", "member-parties-option-" + String(active.id));
  }

  function refreshPartyComboboxActiveStyles() {
    if (!partyComboboxOptionsEl) return;
    var buttons = partyComboboxOptionsEl.querySelectorAll(".member-games-option");
    buttons.forEach(function (btn, idx) {
      var active = idx === partyComboboxActiveIndex;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function renderPartyComboboxOptions() {
    if (!partyComboboxOptionsEl || !partyComboboxEmptyEl || !partyComboboxInputEl) return;
    partyComboboxOptionsEl.replaceChildren();
    var term = String(partyComboboxInputEl.value || "").trim().toLowerCase();
    filteredParties = partiesCache.filter(function (p) {
      return !term || p.__search.indexOf(term) !== -1;
    });
    filteredParties.forEach(function (p, idx) {
      var opt = el("button", {
        type: "button",
        className: "member-games-option",
        role: "option",
        id: "member-parties-option-" + String(p.id),
        "aria-selected": partyComboboxActiveIndex === idx ? "true" : "false"
      });
      opt.textContent = p.__label;
      opt.addEventListener("click", function () {
        startEditParty(p);
        setPartyComboboxOpen(false);
        if (partyComboboxInputEl) partyComboboxInputEl.value = p.__label || "";
      });
      partyComboboxOptionsEl.appendChild(opt);
    });
    if (partyComboboxActiveIndex >= filteredParties.length) partyComboboxActiveIndex = filteredParties.length - 1;
    if (partyComboboxActiveIndex < -1) partyComboboxActiveIndex = -1;
    updatePartyActiveDescendant();
    refreshPartyComboboxActiveStyles();
    partyComboboxEmptyEl.hidden = filteredParties.length > 0;
  }

  function populatePartyCombobox() {
    partiesCache = normalizePartiesForDisplay(partiesCache);
    renderPartyComboboxOptions();
  }

  function updatePartyModeShell() {
    var n = document.getElementById("member-parties-mode-note");
    if (!n) return;
    if (partyEditMode === "idle") {
      n.textContent = "";
      n.hidden = true;
      return;
    }
    n.hidden = false;
    if (partyEditMode === "edit") n.textContent = "Editing an existing directory entry. Save changes or cancel.";
    else if (partyEditMode === "new") n.textContent = "Adding a new party. Full name copies into display until you edit display name.";
    else n.textContent = "";
  }

  function setPartyShellOpen(isOpen) {
    if (!partyFieldsWrapEl) return;
    var show = !!isOpen;
    partyFieldsWrapEl.hidden = !show;
    partyFieldsWrapEl.setAttribute("aria-hidden", show ? "false" : "true");
    updatePartyModeShell();
  }

  function openPartyEditor(nextMode) {
    partyEditMode = nextMode || "edit";
    partyFormDirty = false;
    setPartyShellOpen(true);
  }

  function confirmDiscardPartyIfDirty() {
    if (!partyFormDirty) return true;
    return window.confirm("Discard unsaved party changes?");
  }

  function enterPartyIdleModeInternal(statusMsg) {
    partyEditMode = "idle";
    editingPartyId = null;
    partyFormDirty = false;
    setPartyShellOpen(false);
    if (partyComboboxInputEl) partyComboboxInputEl.value = "";
    setPartyComboboxOpen(false);
    partyComboboxActiveIndex = -1;
    populatePartyCombobox();
    if (statusMsg) setStatus(statusMsg);
  }

  function enterPartyIdleMode(statusMsg) {
    if (!confirmDiscardPartyIfDirty()) return;
    enterPartyIdleModeInternal(statusMsg);
  }

  function onPartyPotentiallyDirty() {
    if (partyEditMode === "idle") return;
    partyFormDirty = true;
  }

  function beginNewPartyFromCombobox() {
    if (!confirmDiscardPartyIfDirty()) return;
    openPartyEditor("new");
    onNewPartyFormCore();
    setPartyComboboxOpen(false);
    if (partyComboboxInputEl) partyComboboxInputEl.value = "";
    var fn = document.getElementById("mg-party-full-name");
    if (fn) fn.focus();
    setStatus("New party. Fill details and save.");
  }

  function onMemberGamesDocumentClick(evt) {
    if (!appEl) return;
    if (comboboxOpen && gameComboWrapEl && !gameComboWrapEl.contains(evt.target)) setComboboxOpen(false);
    if (partyComboboxOpen && partyComboWrapEl && !partyComboWrapEl.contains(evt.target)) setPartyComboboxOpen(false);
  }

  function setMode(nextMode) {
    mode = nextMode;
    var isIdle = mode === "idle";
    formEl.hidden = isIdle;
    formEl.setAttribute("aria-hidden", isIdle ? "true" : "false");
    if (reviewScaffoldsEl) reviewScaffoldsEl.hidden = mode !== "edit";
    var modeNote = document.getElementById("member-games-mode-note");
    if (modeNote) {
      modeNote.textContent =
        mode === "new"
          ? 'Creating game manually (secondary path). Prefer Pinball Map for standard machine additions.'
          : "";
    }
    if (manualWrapEl) manualWrapEl.hidden = mode !== "edit";
    if (saleEl) saleEl.hidden = mode !== "edit";
    if (highScoresWrapEl) highScoresWrapEl.hidden = mode !== "edit";
    if (modsWrapEl) modsWrapEl.hidden = mode !== "edit";
    if (pingolfTargetsWrapEl) pingolfTargetsWrapEl.hidden = mode !== "edit";
    if (pingolfAdminEl) {
      pingolfAdminEl.hidden =
        mode !== "edit" ||
        !(
          window.SNHMemberPortal &&
          window.SNHMemberPortal.memberHasAnyRole &&
          window.SNHMemberPortal.memberHasAnyRole(lastUserRoles || [], "games_admin,club_admin")
        );
    }
    var secGame = document.getElementById("mg-section-game");
    if (secGame) {
      secGame.textContent =
        mode === "new"
          ? "New manual game entry"
          : mode === "edit"
            ? "Edit game catalog"
            : "";
    }
    if (partyLinkWrapEl) partyLinkWrapEl.hidden = mode !== "edit";
    if (stintsSectionEl) stintsSectionEl.hidden = mode !== "edit";
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
      "mg-sale-notes",
      "mg-hs-score",
      "mg-hs-player",
      "mg-hs-notes",
      "mg-mod-title",
      "mg-mod-desc",
      "mg-mod-url",
      "mg-pg-desc",
      "mg-pg-val",
      "mg-pg-admin-title",
      "mg-pg-admin-notes"
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
    var hsDate = document.getElementById("mg-hs-date");
    if (hsDate) hsDate.value = "";
    var featAdmin = document.getElementById("mg-pg-admin-featured");
    if (featAdmin) featAdmin.checked = false;
    var pls = document.getElementById("mg-party-link-select");
    if (pls) pls.value = "";
    var prel = document.getElementById("mg-party-relationship-public");
    if (prel) prel.value = "";
    var gh = document.getElementById("mg-game-hide-owner-public");
    if (gh) gh.checked = false;
    var hsl = document.getElementById("mg-high-scores-list");
    if (hsl) hsl.replaceChildren();
    var ml = document.getElementById("mg-mods-list");
    if (ml) ml.replaceChildren();
    var ptl = document.getElementById("mg-pingolf-target-list");
    if (ptl) ptl.replaceChildren();
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
    resetAiProposalUi();
    if (statusMessage) setStatus(statusMessage);
  }

  function onGameSelected(gameId) {
    if (!confirmDiscardPartyIfDirty()) return;
    if (!confirmDiscardIfDirty()) return;
    populateForm(gameId);
    setComboboxOpen(false);
  }

  function beginNewGameMode() {
    if (!confirmDiscardPartyIfDirty()) return;
    if (!confirmDiscardIfDirty()) return;
    currentGameId = null;
    setMode("new");
    clearFormForNewGame();
    resetAiProposalUi();
    isDirty = false;
    setStatus('Creating new game. Use "Save game" to create a manual entry.');
    focusFirstFormField();
  }

  async function loadPartiesDirectory() {
    if (!window.SNHMemberPortal || !window.SNHMemberPortal.ownerPartiesList) return;
    try {
      var rows = await window.SNHMemberPortal.ownerPartiesList();
      partiesCache = Array.isArray(rows) ? rows : [];
      populatePartyCombobox();
      refreshPartyLinkSelect();
    } catch (e) {
      console.warn("owner parties", e);
    }
  }

  function refreshPartyLinkSelect() {
    var sel = document.getElementById("mg-party-link-select");
    if (!sel) return;
    var cur = sel.value;
    while (sel.options.length > 1) {
      sel.remove(1);
    }
    partiesCache.forEach(function (p) {
      if (!p || !p.id) return;
      var opt = document.createElement("option");
      opt.value = String(p.id);
      var label = (p.fullName || p.displayName || String(p.id)).trim();
      opt.textContent = label.length > 90 ? label.slice(0, 87) + "…" : label;
      sel.appendChild(opt);
    });
    if (cur && Array.prototype.some.call(sel.options, function (o) { return o.value === cur; })) {
      sel.value = cur;
    }
  }

  function syncPartyDirectoryDeleteVisibility() {
    var delBtn = document.getElementById("mg-party-delete");
    if (delBtn) delBtn.hidden = !hasDeleteAccess();
  }

  function startEditParty(p) {
    if (!p) return;
    if (!confirmDiscardPartyIfDirty()) return;
    openPartyEditor("edit");
    editingPartyId = p.id;
    var fn = document.getElementById("mg-party-full-name");
    var dn = document.getElementById("mg-party-display-name");
    if (fn) fn.value = p.fullName || "";
    if (dn) {
      dn.value = p.displayName || "";
      dn.dataset.userEdited = "1";
    }
    var kind = document.getElementById("mg-party-kind");
    if (kind) kind.value = (p.partyKind || "").toLowerCase();
    var vis = document.getElementById("mg-party-vis-public");
    if (vis) vis.checked = p.visibilityPublic !== false;
    var em = document.getElementById("mg-party-email");
    if (em) em.value = p.contactEmail || "";
    var ph = document.getElementById("mg-party-phone");
    if (ph) ph.value = p.contactPhone || "";
    var dc = document.getElementById("mg-party-discord");
    if (dc) dc.value = p.discordOrOther || "";
    var cn = document.getElementById("mg-party-contact-notes");
    if (cn) cn.value = p.contactNotes || "";
    var inn = document.getElementById("mg-party-internal-notes");
    if (inn) inn.value = p.internalNotes || "";
    setStatus("Editing party. Adjust fields and click Save party.");
    if (partyComboboxInputEl) {
      var row = normalizePartiesForDisplay([p])[0];
      partyComboboxInputEl.value = row.__label || "";
    }
    partyFormDirty = false;
  }

  function onNewPartyFormCore() {
    editingPartyId = null;
    var ids = [
      "mg-party-full-name",
      "mg-party-display-name",
      "mg-party-email",
      "mg-party-phone",
      "mg-party-discord",
      "mg-party-contact-notes",
      "mg-party-internal-notes"
    ];
    ids.forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.value = "";
    });
    var dn = document.getElementById("mg-party-display-name");
    if (dn) dn.dataset.userEdited = "0";
    var kind = document.getElementById("mg-party-kind");
    if (kind) kind.value = "";
    var vis = document.getElementById("mg-party-vis-public");
    if (vis) vis.checked = true;
    if (partyComboboxInputEl) partyComboboxInputEl.value = "";
    setPartyComboboxOpen(false);
    partyComboboxActiveIndex = -1;
    populatePartyCombobox();
  }

  function onNewPartyForm() {
    if (!confirmDiscardPartyIfDirty()) return;
    openPartyEditor("new");
    onNewPartyFormCore();
    setStatus("New party. Enter full name (display name copies until you edit it), then Save party.");
    var fn = document.getElementById("mg-party-full-name");
    if (fn) fn.focus();
  }

  async function onSavePartyDirectory() {
    if (!window.SNHMemberPortal) return;
    var full = getVal("mg-party-full-name");
    if (!full) {
      setStatus("Party full name is required.");
      return;
    }
    var dispIn = document.getElementById("mg-party-display-name");
    var disp = dispIn ? String(dispIn.value || "").trim() : "";
    var kindVal = getVal("mg-party-kind");
    var fields = {
      fullName: full,
      displayName: disp || full,
      partyKind: kindVal || null,
      visibilityPublic: !!(document.getElementById("mg-party-vis-public") || {}).checked,
      contactEmail: getVal("mg-party-email") || null,
      contactPhone: getVal("mg-party-phone") || null,
      discordOrOther: getVal("mg-party-discord") || null,
      contactNotes: getVal("mg-party-contact-notes") || null,
      internalNotes: getVal("mg-party-internal-notes") || null
    };
    setStatus("Saving party…");
    try {
      await window.SNHMemberPortal.ownerPartiesUpsert(editingPartyId, fields);
      partyFormDirty = false;
      await loadPartiesDirectory();
      openPartyEditor("new");
      onNewPartyFormCore();
      setStatus("Party saved.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function onDeletePartyById(partyId) {
    if (!partyId || !window.SNHMemberPortal || !confirm("Delete this party? Games linked to it will lose the link.")) return;
    try {
      await window.SNHMemberPortal.ownerPartiesDelete(partyId);
      if (String(editingPartyId) === String(partyId)) enterPartyIdleModeInternal(null);
      await loadPartiesDirectory();
      if (currentGameId) {
        var data = await window.SNHMemberPortal.gamesEditorLoad();
        gamesCache = (data && data.games) || [];
        await populateForm(currentGameId);
      }
      setStatus("Party deleted.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function onDeletePartyDirectory() {
    if (!editingPartyId) {
      setStatus("Select a party in Owner parties (below) before deleting.");
      return;
    }
    await onDeletePartyById(editingPartyId);
  }

  async function persistPartyLinkFromForm(gameId) {
    if (!gameId || !window.SNHMemberPortal) return;
    var sel = document.getElementById("mg-party-link-select");
    var pid = sel && sel.value ? sel.value : null;
    var rel = getVal("mg-party-relationship-public");
    var hideEl = document.getElementById("mg-game-hide-owner-public");
    var hide = !!(hideEl && hideEl.checked);
    await window.SNHMemberPortal.gamesSetPartyLink(gameId, pid, rel || null, hide);
  }

  async function onSavePartyLink() {
    if (!currentGameId || !window.SNHMemberPortal) return;
    setStatus("Saving owner link…");
    try {
      await persistPartyLinkFromForm(currentGameId);
      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      populateCombobox();
      await populateForm(currentGameId);
      setStatus("Owner link saved.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function onClearPartyLink() {
    if (!currentGameId || !window.SNHMemberPortal) return;
    var hideEl = document.getElementById("mg-game-hide-owner-public");
    var hide = !!(hideEl && hideEl.checked);
    setStatus("Clearing owner link…");
    try {
      await window.SNHMemberPortal.gamesSetPartyLink(currentGameId, null, null, hide);
      var sel = document.getElementById("mg-party-link-select");
      if (sel) sel.value = "";
      var rel = document.getElementById("mg-party-relationship-public");
      if (rel) rel.value = "";
      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      populateCombobox();
      await populateForm(currentGameId);
      setStatus("Owner link cleared.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  function appendPartyGameLinkSection() {
    var inner = el("div", { className: "member-games-party-link", id: "mg-party-link-wrap" });
    inner.appendChild(
      el("p", {
        className: "member-games-help",
        text: "Add or edit contacts in Owner parties (section below this form). Saved parties appear in this list for the open game only."
      })
    );
    var partySel = el("select", { id: "mg-party-link-select", className: "member-games-input" });
    partySel.appendChild(el("option", { value: "", text: "(no party linked)" }));
    inner.appendChild(fieldRow("Party", partySel));
    inner.appendChild(fieldRow("Public relationship label", textInput("mg-party-relationship-public", "")));
    var hideOwnerRow = el("div", { className: "member-games-field member-games-checkbox-row" });
    var hideOwnerCb = el("input", { type: "checkbox", id: "mg-game-hide-owner-public" });
    hideOwnerRow.appendChild(hideOwnerCb);
    hideOwnerRow.appendChild(
      el("label", { for: "mg-game-hide-owner-public", text: "Hide owner from public More Info (this game)" })
    );
    inner.appendChild(hideOwnerRow);
    var partyLinkActions = el("div", { className: "member-games-form-actions" });
    var savePartyLinkBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-party-link-save" });
    savePartyLinkBtn.textContent = "Save owner link";
    savePartyLinkBtn.addEventListener("click", function () {
      void onSavePartyLink();
    });
    var clearPartyLinkBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-party-link-clear" });
    clearPartyLinkBtn.textContent = "Clear link";
    clearPartyLinkBtn.addEventListener("click", function () {
      void onClearPartyLink();
    });
    partyLinkActions.appendChild(savePartyLinkBtn);
    partyLinkActions.appendChild(clearPartyLinkBtn);
    inner.appendChild(partyLinkActions);
    partyLinkWrapEl = wrapCollapsible("Link owner to this game", inner, "member-games-collapsible-party");
    formEl.appendChild(partyLinkWrapEl);
  }

  function buildPartiesMainStrip() {
    partiesBlockEl = el("div", {
      className: "member-games-parties-block member-games-parties-dir",
      id: "mg-parties-block"
    });
    partiesBlockEl.appendChild(
      el("h3", {
        className: "member-games-section-heading",
        text: "Owner parties directory"
      })
    );
    partiesBlockEl.appendChild(
      el("p", {
        className: "member-games-help",
        text: "Search or + New party to edit directory records (fields open when you pick one). To attach a party to a machine, open that game in the catalog editor above."
      })
    );

    partyComboWrapEl = el("div", { className: "member-games-combobox" });
    partyComboboxInputEl = el("input", {
      type: "text",
      id: "member-parties-combobox-input",
      className: "member-games-input member-games-combobox-input",
      role: "combobox",
      "aria-expanded": "false",
      "aria-controls": partyComboboxListboxId,
      "aria-autocomplete": "list",
      autocomplete: "off",
      placeholder: "Search parties by full or display name…"
    });
    partyComboboxPanelEl = el("div", {
      className: "member-games-combobox-panel",
      hidden: "hidden",
      id: "member-parties-combobox-panel"
    });
    partyComboboxOptionsEl = el("div", {
      className: "member-games-options",
      id: partyComboboxListboxId,
      role: "listbox"
    });
    var partyPinnedNew = el("button", { type: "button", className: "member-games-option member-games-option--new" });
    partyPinnedNew.textContent = "+ New party";
    partyPinnedNew.addEventListener("click", function () {
      beginNewPartyFromCombobox();
    });
    partyComboboxEmptyEl = el("div", { className: "member-games-empty", hidden: "hidden" });
    partyComboboxEmptyEl.appendChild(el("p", { text: "No parties match that search yet." }));
    partyComboboxEmptyEl.appendChild(el("p", { text: "Refine search or create a directory entry." }));
    var partyEmptyNew = el("button", { type: "button", className: "members-sidebar-link" });
    partyEmptyNew.textContent = "+ New party";
    partyEmptyNew.addEventListener("click", function () {
      beginNewPartyFromCombobox();
    });
    partyComboboxEmptyEl.appendChild(partyEmptyNew);
    partyComboboxPanelEl.appendChild(partyComboboxOptionsEl);
    partyComboboxPanelEl.appendChild(partyPinnedNew);
    partyComboboxPanelEl.appendChild(partyComboboxEmptyEl);
    partyComboWrapEl.appendChild(partyComboboxInputEl);
    partyComboWrapEl.appendChild(partyComboboxPanelEl);
    partiesBlockEl.appendChild(fieldRow("Search directory", partyComboWrapEl));

    partyComboboxInputEl.addEventListener("focus", function () {
      setPartyComboboxOpen(true);
      renderPartyComboboxOptions();
    });
    partyComboboxInputEl.addEventListener("click", function () {
      setPartyComboboxOpen(true);
      renderPartyComboboxOptions();
    });
    partyComboboxInputEl.addEventListener("input", function () {
      setPartyComboboxOpen(true);
      partyComboboxActiveIndex = -1;
      renderPartyComboboxOptions();
    });
    partyComboboxInputEl.addEventListener("keydown", function (evt) {
      if (evt.key === "ArrowDown") {
        evt.preventDefault();
        if (!partyComboboxOpen) setPartyComboboxOpen(true);
        if (filteredParties.length) {
          partyComboboxActiveIndex = Math.min(filteredParties.length - 1, partyComboboxActiveIndex + 1);
          refreshPartyComboboxActiveStyles();
          updatePartyActiveDescendant();
        }
      } else if (evt.key === "ArrowUp") {
        evt.preventDefault();
        if (!partyComboboxOpen) setPartyComboboxOpen(true);
        if (filteredParties.length) {
          partyComboboxActiveIndex = Math.max(0, partyComboboxActiveIndex - 1);
          refreshPartyComboboxActiveStyles();
          updatePartyActiveDescendant();
        }
      } else if (evt.key === "Enter") {
        if (!partyComboboxOpen) return;
        evt.preventDefault();
        if (partyComboboxActiveIndex >= 0 && partyComboboxActiveIndex < filteredParties.length) {
          var pPick = filteredParties[partyComboboxActiveIndex];
          startEditParty(pPick);
          setPartyComboboxOpen(false);
          if (partyComboboxInputEl) partyComboboxInputEl.value = pPick.__label || "";
        } else if (!filteredParties.length) {
          beginNewPartyFromCombobox();
        }
      } else if (evt.key === "Escape") {
        if (partyComboboxOpen) {
          evt.preventDefault();
          setPartyComboboxOpen(false);
          partyComboboxInputEl.focus();
        }
      }
    });

    partyFieldsWrapEl = el("div", {
      className: "member-games-party-fields-shell",
      id: "mg-party-fields-shell",
      hidden: "hidden",
      "aria-hidden": "true"
    });
    partyFieldsWrapEl.appendChild(
      el("p", {
        className: "member-games-mode-note",
        id: "member-parties-mode-note",
        text: "",
        hidden: "hidden"
      })
    );

    partyFieldsWrapEl.appendChild(
      el("h4", { className: "member-games-parties-block-heading", text: "Party details and contacts" })
    );
    var fnIn = textInput("mg-party-full-name", "");
    var dnIn = textInput("mg-party-display-name", "");
    dnIn.dataset.userEdited = "0";
    fnIn.addEventListener("input", function () {
      if (editingPartyId) return;
      if (dnIn.dataset.userEdited === "1") return;
      dnIn.value = fnIn.value;
    });
    dnIn.addEventListener("input", function () {
      dnIn.dataset.userEdited = "1";
    });
    partyFieldsWrapEl.appendChild(fieldRow("Full name", fnIn));
    partyFieldsWrapEl.appendChild(fieldRow("Display name (public)", dnIn));
    var kindSel = el("select", { id: "mg-party-kind", className: "member-games-input" });
    kindSel.appendChild(el("option", { value: "", text: "(unspecified)" }));
    ["person", "organization", "club", "operator"].forEach(function (k) {
      var o = el("option", { value: k });
      o.textContent = k;
      kindSel.appendChild(o);
    });
    partyFieldsWrapEl.appendChild(fieldRow("Kind", kindSel));
    var visRow = el("div", { className: "member-games-field member-games-checkbox-row" });
    var visCb = el("input", { type: "checkbox", id: "mg-party-vis-public" });
    visCb.checked = true;
    visRow.appendChild(visCb);
    visRow.appendChild(el("label", { for: "mg-party-vis-public", text: "Allow display name on public More Info" }));
    partyFieldsWrapEl.appendChild(visRow);
    partyFieldsWrapEl.appendChild(fieldRow("Contact email", textInput("mg-party-email", "")));
    partyFieldsWrapEl.appendChild(fieldRow("Contact phone", textInput("mg-party-phone", "")));
    partyFieldsWrapEl.appendChild(fieldRow("Discord / other", textInput("mg-party-discord", "")));
    var cnotes = textareaInput("mg-party-contact-notes", "");
    cnotes.setAttribute("rows", "3");
    partyFieldsWrapEl.appendChild(fieldRow("Contact notes", cnotes));
    var inotes = textareaInput("mg-party-internal-notes", "");
    inotes.setAttribute("rows", "3");
    partyFieldsWrapEl.appendChild(fieldRow("Internal notes", inotes));
    var pActions = el("div", { className: "member-games-form-actions" });
    var newPB = el("button", { type: "button", className: "members-sidebar-link", id: "mg-party-new" });
    newPB.textContent = "New party";
    newPB.addEventListener("click", onNewPartyForm);
    var savePB = el("button", { type: "button", className: "members-sidebar-link", id: "mg-party-save" });
    savePB.textContent = "Save party";
    savePB.addEventListener("click", function () {
      void onSavePartyDirectory();
    });
    var delPB = el("button", { type: "button", className: "members-sidebar-link", id: "mg-party-delete" });
    delPB.textContent = "Delete party";
    delPB.addEventListener("click", function () {
      void onDeletePartyDirectory();
    });
    var cancelPB = el("button", { type: "button", className: "members-sidebar-link", id: "mg-party-cancel" });
    cancelPB.textContent = "Cancel";
    cancelPB.addEventListener("click", function () {
      enterPartyIdleMode("Party editing closed.");
    });
    pActions.appendChild(newPB);
    pActions.appendChild(savePB);
    pActions.appendChild(delPB);
    pActions.appendChild(cancelPB);
    partyFieldsWrapEl.appendChild(pActions);

    partyFieldsWrapEl.addEventListener("input", onPartyPotentiallyDirty);
    partyFieldsWrapEl.addEventListener("change", onPartyPotentiallyDirty);

    partiesBlockEl.appendChild(partyFieldsWrapEl);

    return partiesBlockEl;
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
    wrap.appendChild(
      el("p", {
        className: "member-games-help",
        text: "Search or pick a game to open the catalog editor directly under this search. Owner parties stay in a separate section farther down; open a game first to link one."
      })
    );
    var row = el("div", { className: "member-games-picker-row" });
    var comboWrap = el("div", { className: "member-games-combobox" });
    gameComboWrapEl = comboWrap;
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
    var toggleRow = el("label", { className: "member-games-help", for: "member-games-at-club-only-toggle" });
    atClubOnlyToggleEl = el("input", {
      type: "checkbox",
      id: "member-games-at-club-only-toggle"
    });
    atClubOnlyToggleEl.checked = !!filterAtClubOnly;
    atClubOnlyToggleEl.addEventListener("change", function () {
      filterAtClubOnly = !!atClubOnlyToggleEl.checked;
      if (!catalogLoaded) return;
      setComboboxOpen(true);
      comboboxActiveIndex = -1;
      renderComboboxOptions();
    });
    toggleRow.appendChild(atClubOnlyToggleEl);
    toggleRow.appendChild(document.createTextNode(" Only at club today"));
    wrap.appendChild(toggleRow);
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
    return wrap;
  }

  function makeAiFieldKeyCheckboxId(fieldKey) {
    return "mg-ai-apply-" + String(fieldKey || "").replace(/[^a-zA-Z0-9_-]+/g, "-");
  }

  function isAiProposalLinkField(fieldKey) {
    return fieldKey === "ipdbUrl" || fieldKey === "pinsideUrl" || fieldKey === "kineticistUrl";
  }

  /** Prefix like "Current: " or ""; opens http(s) values in a new tab for verification. */
  function appendAiProposalUrlParagraph(row, prefixText, rawValue) {
    var v = String(rawValue || "").trim();
    var p = el("p", { className: "member-games-help" });
    if (prefixText) p.appendChild(document.createTextNode(prefixText));
    if (!v) {
      p.appendChild(document.createTextNode("—"));
      row.appendChild(p);
      return;
    }
    if (isValidHttpUrl(v)) {
      p.appendChild(
        el("a", {
          href: v,
          target: "_blank",
          rel: "noopener noreferrer",
          className: "member-games-ai-external-link",
          text: v,
        })
      );
    } else {
      p.appendChild(document.createTextNode(v));
    }
    row.appendChild(p);
  }

  function setAiStatus(msg) {
    if (aiStatusEl) aiStatusEl.textContent = msg || "";
  }

  function resetAiProposalUi() {
    aiProposalData = null;
    aiDescriptionRegenCount = 0;
    aiImageRegenCount = 0;
    if (aiProposalBodyEl) aiProposalBodyEl.replaceChildren();
    setAiStatus("");
  }

  function renderAiProposal(proposal) {
    if (!aiProposalBodyEl) return;
    aiProposalBodyEl.replaceChildren();
    aiProposalData = proposal || null;
    if (!proposal) return;

    var intro = el("p", {
      className: "member-games-help",
      text: "Review field suggestions, then apply selected fields."
    });
    aiProposalBodyEl.appendChild(intro);

    var warningList = proposal.warnings || [];
    if (warningList.length) {
      var warn = el("ul", { className: "member-games-ai-warnings" });
      warningList.forEach(function (w) {
        warn.appendChild(el("li", { text: String(w) }));
      });
      aiProposalBodyEl.appendChild(warn);
    }

    var fields = Array.isArray(proposal.fields) ? proposal.fields : [];
    fields.forEach(function (f) {
      if (!f || !f.field) return;
      var row = el("div", { className: "member-games-ai-field" });

      var isExistingLinkRetained =
        String(f.reason || "").trim() === "Existing link retained." && isAiProposalLinkField(f.field);

      if (isExistingLinkRetained) {
        row.classList.add("member-games-ai-field-link-confirmed");
        var retainedLine = el("p", { className: "member-games-help" });
        retainedLine.appendChild(document.createTextNode(String(f.field) + ": confirmed. "));
        var keptUrl = String(f.currentValue || f.suggestedValue || "").trim();
        if (keptUrl && isValidHttpUrl(keptUrl)) {
          retainedLine.appendChild(
            el("a", {
              href: keptUrl,
              target: "_blank",
              rel: "noopener noreferrer",
              className: "member-games-ai-external-link",
              text: keptUrl,
            })
          );
        } else if (keptUrl) {
          retainedLine.appendChild(document.createTextNode(keptUrl));
        } else {
          retainedLine.appendChild(document.createTextNode("—"));
        }
        row.appendChild(retainedLine);
        aiProposalBodyEl.appendChild(row);
        return;
      }

      var checkboxId = makeAiFieldKeyCheckboxId(f.field);
      var cb = el("input", { type: "checkbox", id: checkboxId });
      cb.checked = !!f.applyByDefault && !f.reviewRequired;
      if (f.reviewRequired) cb.checked = false;
      var label = el("label", { for: checkboxId, text: String(f.field) + " (" + fmtConfidence(f.confidenceScore) + ")" });
      row.appendChild(cb);
      row.appendChild(label);

      var currentText = String(f.currentValue || "").trim() || "—";
      var suggestedText = String(f.suggestedValue || "").trim() || "—";
      if (isAiProposalLinkField(f.field)) {
        appendAiProposalUrlParagraph(row, "Current: ", f.currentValue);
        appendAiProposalUrlParagraph(row, "Suggested: ", f.suggestedValue);
      } else {
        row.appendChild(el("p", { className: "member-games-help", text: "Current: " + currentText }));
        row.appendChild(el("p", { className: "member-games-help", text: "Suggested: " + suggestedText }));
      }
      if (f.reason) row.appendChild(el("p", { className: "member-games-help", text: "Reason: " + String(f.reason) }));
      var fw = Array.isArray(f.warnings) ? f.warnings : [];
      if (fw.length) {
        var fwul = el("ul", { className: "member-games-ai-warnings" });
        fw.forEach(function (w) {
          fwul.appendChild(el("li", { text: String(w) }));
        });
        row.appendChild(fwul);
      }
      aiProposalBodyEl.appendChild(row);
    });

    var imgs = Array.isArray(proposal.imageCandidates) ? proposal.imageCandidates : [];
    if (imgs.length) {
      var imgsWrap = el("div", { className: "member-games-ai-images" });
      imgsWrap.appendChild(el("h5", { text: "Image candidates" }));
      imgsWrap.appendChild(
        el("p", {
          className: "member-games-help member-games-ai-images-intro",
          text:
            "These previews are not uploaded automatically. Download an image you are allowed to use, add the file to assets/images/machines in the website project, publish that build to hosting, then type the file name into the Image field on this form and save the game. Add OPDB credit in More info or the description. Apply selected fields only updates catalog data; it does not download images from the web.",
        })
      );
      imgs.forEach(function (img, idx) {
        var imgRow = el("div", { className: "member-games-ai-image-row" });
        var thumbSrc = String((img && img.imageUrl) || "").trim();
        var thumbEl;
        var attrNote = String((img && img.licenseOrUsageNote) || "").trim();
        var attrReq = !!(img && img.attributionRequired);
        var altBits = ["Candidate " + (idx + 1)];
        if (attrReq || attrNote) altBits.push("preview for review only");
        if (thumbSrc) {
          thumbEl = el("img", {
            className: "member-games-ai-image-preview",
            alt: altBits.join(", "),
            src: thumbSrc,
          });
        } else {
          var placeholder = el("div", {
            className: "member-games-ai-image-placeholder",
            role: "img",
            "aria-label": "No thumbnail for candidate " + (idx + 1),
          });
          placeholder.appendChild(
            el("span", { className: "member-games-ai-image-placeholder-note", text: "No inline preview." })
          );
          var ref = String((img && img.sourceUrl) || "").trim();
          if (ref && isValidHttpUrl(ref)) {
            placeholder.appendChild(
              el("a", {
                className: "member-games-ai-image-ref-link",
                href: ref,
                target: "_blank",
                rel: "noopener noreferrer",
                text: "Open reference page",
              })
            );
          }
          thumbEl = placeholder;
        }
        var meta = el("p", {
          className: "member-games-help",
          text: "Score " +
            fmtConfidence(Number(img.qualityScore || 0)) +
            " · " +
            String(img.sourceType || "source") +
            (img.attributionRequired ? " · attribution required" : "")
        });
        imgRow.appendChild(thumbEl);
        imgRow.appendChild(meta);

        var srcUrl = String((img && img.sourceUrl) || "").trim();
        var showAttrBlock = !!(attrNote || attrReq || (srcUrl && isValidHttpUrl(srcUrl)));
        if (showAttrBlock) {
          var attrWrap = el("div", { className: "member-games-ai-image-attribution" });
          var usageP = el("p", { className: "member-games-ai-image-attribution-usage" });
          usageP.appendChild(el("span", { className: "member-games-ai-image-attribution-label", text: "Usage / credit: " }));
          if (attrNote) {
            usageP.appendChild(document.createTextNode(attrNote));
          } else if (attrReq) {
            usageP.appendChild(
              document.createTextNode(
                "Confirm license terms with the source before hosting this image on the public catalog."
              )
            );
          } else {
            usageP.appendChild(document.createTextNode("See source link below."));
          }
          attrWrap.appendChild(usageP);
          if (srcUrl && isValidHttpUrl(srcUrl)) {
            var srcP = el("p", { className: "member-games-ai-image-attribution-source" });
            srcP.appendChild(document.createTextNode("Source: "));
            var disp = srcUrl.length > 88 ? srcUrl.slice(0, 85) + "…" : srcUrl;
            srcP.appendChild(
              el("a", {
                href: srcUrl,
                target: "_blank",
                rel: "noopener noreferrer",
                className: "member-games-ai-external-link",
                title: srcUrl,
                text: disp,
              })
            );
            attrWrap.appendChild(srcP);
          }
          imgRow.appendChild(attrWrap);
        }

        imgsWrap.appendChild(imgRow);
      });
      aiProposalBodyEl.appendChild(imgsWrap);
    }
  }

  async function runAiPropose(opts) {
    if (!currentGameId || !window.SNHMemberPortal || !window.SNHMemberPortal.aiGameEnrichPropose) return;
    if (aiBusy) return;
    aiBusy = true;
    setAiStatus("Generating AI proposal…");
    try {
      var proposal = await window.SNHMemberPortal.aiGameEnrichPropose({
        gameId: currentGameId,
        regenerateDescription: !!(opts && opts.regenerateDescription),
        regenerateImageCandidates: !!(opts && opts.regenerateImageCandidates),
      });
      renderAiProposal(proposal);
      setAiStatus("AI proposal ready.");
    } catch (err) {
      setAiStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    } finally {
      aiBusy = false;
    }
  }

  function collectAiSelectedFields() {
    var out = {};
    if (!aiProposalData || !Array.isArray(aiProposalData.fields)) return out;
    aiProposalData.fields.forEach(function (f) {
      if (!f || !f.field) return;
      var cb = document.getElementById(makeAiFieldKeyCheckboxId(f.field));
      if (!cb || !cb.checked) return;
      if (f.field === "details") out.details = f.suggestedValue || "";
      if (f.field === "ipdbUrl") out.ipdbUrl = f.suggestedValue || null;
      if (f.field === "pinsideUrl") out.pinsideUrl = f.suggestedValue || null;
      if (f.field === "kineticistUrl") out.kineticistUrl = f.suggestedValue || null;
      if (f.field === "imageFilename") out.imageFilename = f.suggestedValue || null;
    });
    return out;
  }

  async function onApplyAiSelection() {
    if (!currentGameId || !window.SNHMemberPortal || !aiProposalData) return;
    var selected = collectAiSelectedFields();
    var keys = Object.keys(selected);
    if (!keys.length) {
      setAiStatus("Select at least one field to apply.");
      return;
    }
    if (selected.ipdbUrl && !isValidHttpUrl(selected.ipdbUrl)) {
      setAiStatus("IPDB URL is invalid. Deselect or fix before apply.");
      return;
    }
    if (selected.pinsideUrl && !isValidHttpUrl(selected.pinsideUrl)) {
      setAiStatus("Pinside URL is invalid. Deselect or fix before apply.");
      return;
    }
    if (selected.kineticistUrl && !isValidHttpUrl(selected.kineticistUrl)) {
      setAiStatus("Kineticist URL is invalid. Deselect or fix before apply.");
      return;
    }
    setAiStatus("Applying selected AI fields…");
    try {
      await window.SNHMemberPortal.gamesUpsert(currentGameId, selected);
      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      populateCombobox();
      await populateForm(currentGameId);
      setAiStatus("Applied selected AI fields.");
      isDirty = false;
    } catch (err) {
      setAiStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  function buildReviewScaffolds() {
    reviewScaffoldsEl = el("div", { className: "member-games-review-scaffolds" });
    var missing = el("section", { className: "member-games-review-card" });
    missing.appendChild(el("h4", { text: "AI enrichment assistant" }));
    missing.appendChild(
      el("p", {
        text: "Open a game, run AI refresh, then review and apply only the fields you approve."
      })
    );
    missing.appendChild(
      el("p", {
        className: "member-games-help",
        text:
          "Image previews work best when this game already has a club photo filename. Listing sites often block inline thumbnails in the browser. Open Pinball Database artwork previews can be wired up separately for editors.",
      })
    );
    aiWrapEl = missing;
    var actions = el("div", { className: "member-games-form-actions" });
    var proposeBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-ai-refresh" });
    proposeBtn.textContent = "AI refresh current game";
    proposeBtn.addEventListener("click", function () {
      if (!currentGameId || mode !== "edit") {
        setAiStatus("Select a game first.");
        return;
      }
      void runAiPropose({});
    });
    var regenDescBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-ai-regen-desc" });
    regenDescBtn.textContent = "Regenerate description";
    regenDescBtn.addEventListener("click", function () {
      if (aiDescriptionRegenCount >= 2) {
        setAiStatus("Description regenerate limit reached for this session.");
        return;
      }
      aiDescriptionRegenCount += 1;
      void runAiPropose({ regenerateDescription: true });
    });
    var regenImgBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-ai-regen-img" });
    regenImgBtn.textContent = "Regenerate image candidates";
    regenImgBtn.addEventListener("click", function () {
      if (aiImageRegenCount >= 1) {
        setAiStatus("Image regenerate limit reached for this session.");
        return;
      }
      aiImageRegenCount += 1;
      void runAiPropose({ regenerateImageCandidates: true });
    });
    var applyBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-ai-apply" });
    applyBtn.textContent = "Apply selected AI fields";
    applyBtn.addEventListener("click", function () {
      void onApplyAiSelection();
    });
    actions.appendChild(proposeBtn);
    actions.appendChild(regenDescBtn);
    actions.appendChild(regenImgBtn);
    actions.appendChild(applyBtn);
    missing.appendChild(actions);
    aiStatusEl = el("p", { className: "member-games-help", id: "mg-ai-status" });
    aiProposalBodyEl = el("div", { className: "member-games-ai-proposal", id: "mg-ai-proposal" });
    missing.appendChild(aiStatusEl);
    missing.appendChild(aiProposalBodyEl);
    reviewScaffoldsEl.appendChild(missing);
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

  async function refreshFeaturedPingolfSession() {
    featuredPingolfSessionId = null;
    if (!window.SNHMemberPortal || !window.SNHMemberPortal.pingolfSessionsListEditor) return;
    try {
      var sessions = await window.SNHMemberPortal.pingolfSessionsListEditor();
      var arr = Array.isArray(sessions) ? sessions : [];
      var f = arr.find(function (s) {
        return s && s.isFeatured;
      });
      featuredPingolfSessionId = f && f.id ? f.id : null;
    } catch (e) {
      console.warn("pingolf sessions", e);
    }
  }

  function todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
  }

  async function loadHighScoresForGame(gameId) {
    var box = document.getElementById("mg-high-scores-list");
    var dh = document.getElementById("mg-hs-date");
    if (dh && !dh.value) dh.value = todayIsoDate();
    if (!box || !window.SNHMemberPortal || !window.SNHMemberPortal.gameHighScoresList) return;
    try {
      var rows = await window.SNHMemberPortal.gameHighScoresList(gameId);
      var arr = Array.isArray(rows) ? rows : [];
      renderHighScoresList(arr);
    } catch (e) {
      console.warn("high scores", e);
      box.textContent = "Could not load scores.";
    }
  }

  function renderHighScoresList(arr) {
    var box = document.getElementById("mg-high-scores-list");
    if (!box) return;
    box.replaceChildren();
    (arr || []).forEach(function (row) {
      var line = el("div", { className: "member-games-sublist-row" });
      line.appendChild(
        el("span", {
          text:
            formatHighScoreDisplay(row.score) +
            " · " +
            (row.playerLabel || "—") +
            " · " +
            (row.achievedOn || "")
        })
      );
      if (hasDeleteAccess() && row.id) {
        var del = el("button", { type: "button", className: "members-sidebar-link" });
        del.textContent = "Delete";
        del.addEventListener("click", function () {
          onDeleteHighScore(row.id);
        });
        line.appendChild(del);
      }
      box.appendChild(line);
    });
  }

  async function onAddHighScore() {
    if (!currentGameId || !window.SNHMemberPortal) return;
    var scoreEl = document.getElementById("mg-hs-score");
    var scoreRaw = scoreEl ? parseScoreFieldRaw(scoreEl.value) : "";
    if (!scoreRaw) {
      setStatus("Score is required.");
      return;
    }
    setStatus("Adding score…");
    try {
      await window.SNHMemberPortal.gameHighScoresUpsert(null, currentGameId, {
        score: Number(scoreRaw),
        playerLabel: getVal("mg-hs-player"),
        achievedOn: getVal("mg-hs-date") || todayIsoDate(),
        notes: getVal("mg-hs-notes") || null
      });
      document.getElementById("mg-hs-score").value = "";
      document.getElementById("mg-hs-player").value = "";
      document.getElementById("mg-hs-notes").value = "";
      await loadHighScoresForGame(currentGameId);
      setStatus("High score added.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function onDeleteHighScore(scoreId) {
    if (!scoreId || !confirm("Delete this high score?")) return;
    try {
      await window.SNHMemberPortal.gameHighScoresDelete(scoreId);
      await loadHighScoresForGame(currentGameId);
      setStatus("Score deleted.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function loadModsForGame(gameId) {
    var box = document.getElementById("mg-mods-list");
    if (!box || !window.SNHMemberPortal || !window.SNHMemberPortal.gameCustomModsList) return;
    try {
      var rows = await window.SNHMemberPortal.gameCustomModsList(gameId);
      var arr = Array.isArray(rows) ? rows : [];
      renderModsList(arr);
    } catch (e) {
      console.warn("mods", e);
      box.textContent = "Could not load mods.";
    }
  }

  function renderModsList(arr) {
    var box = document.getElementById("mg-mods-list");
    if (!box) return;
    box.replaceChildren();
    (arr || []).forEach(function (row) {
      var line = el("div", { className: "member-games-sublist-row" });
      line.appendChild(el("span", { text: row.title || "—" }));
      if (hasDeleteAccess() && row.id) {
        var del = el("button", { type: "button", className: "members-sidebar-link" });
        del.textContent = "Delete";
        del.addEventListener("click", function () {
          onDeleteMod(row.id);
        });
        line.appendChild(del);
      }
      box.appendChild(line);
    });
  }

  async function onAddMod() {
    if (!currentGameId || !window.SNHMemberPortal) return;
    var title = getVal("mg-mod-title");
    if (!title) {
      setStatus("Mod title is required.");
      return;
    }
    setStatus("Adding mod…");
    try {
      await window.SNHMemberPortal.gameCustomModsUpsert(null, currentGameId, {
        title: title,
        description: getVal("mg-mod-desc") || null,
        referenceUrl: getVal("mg-mod-url") || null
      });
      document.getElementById("mg-mod-title").value = "";
      document.getElementById("mg-mod-desc").value = "";
      document.getElementById("mg-mod-url").value = "";
      await loadModsForGame(currentGameId);
      setStatus("Mod added.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function onDeleteMod(modId) {
    if (!modId || !confirm("Delete this mod entry?")) return;
    try {
      await window.SNHMemberPortal.gameCustomModsDelete(modId);
      await loadModsForGame(currentGameId);
      setStatus("Mod deleted.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function loadPingolfTargetsForGame(gameId) {
    var box = document.getElementById("mg-pingolf-target-list");
    var help = document.getElementById("mg-pingolf-help");
    if (!box || !window.SNHMemberPortal) return;
    if (!featuredPingolfSessionId) {
      if (help) help.textContent = "No featured Pingolf session. A games_admin can create one below.";
      box.replaceChildren();
      return;
    }
    if (help) help.textContent = "Targets apply to the featured Pingolf session only.";
    try {
      var targets = await window.SNHMemberPortal.pingolfTargetsListEditor(featuredPingolfSessionId);
      var arr = Array.isArray(targets) ? targets : [];
      var forGame = arr.filter(function (t) {
        return String(t.gameId) === String(gameId);
      });
      renderPingolfTargets(forGame);
    } catch (e) {
      console.warn("pingolf targets", e);
      box.textContent = "Could not load Pingolf targets.";
    }
  }

  function renderPingolfTargets(arr) {
    var box = document.getElementById("mg-pingolf-target-list");
    if (!box) return;
    box.replaceChildren();
    (arr || []).forEach(function (row) {
      var line = el("div", { className: "member-games-sublist-row" });
      line.appendChild(
        el("span", {
          text: (row.description || "—") + (row.targetValue != null ? " · " + row.targetValue : "")
        })
      );
      var del = el("button", { type: "button", className: "members-sidebar-link" });
      del.textContent = "Delete";
      del.addEventListener("click", function () {
        onDeletePingolfTarget(row.id);
      });
      line.appendChild(del);
      box.appendChild(line);
    });
  }

  async function onAddPingolfTarget() {
    if (!currentGameId || !featuredPingolfSessionId || !window.SNHMemberPortal) return;
    var desc = getVal("mg-pg-desc");
    if (!desc) {
      setStatus("Pingolf target description is required.");
      return;
    }
    setStatus("Adding Pingolf target…");
    try {
      await window.SNHMemberPortal.pingolfTargetUpsert(null, featuredPingolfSessionId, currentGameId, {
        description: desc,
        targetValue: getVal("mg-pg-val") ? Number(getVal("mg-pg-val")) : null
      });
      document.getElementById("mg-pg-desc").value = "";
      document.getElementById("mg-pg-val").value = "";
      await loadPingolfTargetsForGame(currentGameId);
      setStatus("Pingolf target added.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function onDeletePingolfTarget(targetId) {
    if (!targetId || !confirm("Delete this Pingolf target?")) return;
    try {
      await window.SNHMemberPortal.pingolfTargetDelete(targetId);
      await loadPingolfTargetsForGame(currentGameId);
      setStatus("Pingolf target deleted.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  async function renderPingolfAdmin() {
    if (!pingolfAdminEl) return;
    var ul = pingolfAdminEl.querySelector(".mg-pingolf-session-ul");
    if (!ul || !window.SNHMemberPortal) return;
    ul.replaceChildren();
    try {
      var sessions = await window.SNHMemberPortal.pingolfSessionsListEditor();
      var arr = Array.isArray(sessions) ? sessions : [];
      arr.forEach(function (s) {
        var li = el("li", {});
        li.textContent =
          (s.title || "Untitled") +
          (s.isFeatured ? " ★ featured" : "") +
          " · " +
          String(s.id).slice(0, 8) +
          "…";
        ul.appendChild(li);
      });
    } catch (e) {
      ul.appendChild(el("li", { text: "Could not load sessions." }));
    }
  }

  async function onCreatePingolfSession() {
    if (!window.SNHMemberPortal || !window.SNHMemberPortal.memberHasAnyRole) return;
    if (!window.SNHMemberPortal.memberHasAnyRole(lastUserRoles || [], "games_admin,club_admin")) {
      setStatus("Games admin role required for Pingolf sessions.");
      return;
    }
    var title = getVal("mg-pg-admin-title");
    if (!title) {
      setStatus("Session title is required.");
      return;
    }
    setStatus("Saving Pingolf session…");
    try {
      var featured = document.getElementById("mg-pg-admin-featured");
      await window.SNHMemberPortal.pingolfSessionUpsert(null, {
        title: title,
        isFeatured: !!(featured && featured.checked),
        notes: getVal("mg-pg-admin-notes") || null
      });
      document.getElementById("mg-pg-admin-title").value = "";
      if (featured) featured.checked = false;
      document.getElementById("mg-pg-admin-notes").value = "";
      await refreshFeaturedPingolfSession();
      await renderPingolfAdmin();
      if (currentGameId) await loadPingolfTargetsForGame(currentGameId);
      setStatus("Pingolf session saved.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
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
    await refreshFeaturedPingolfSession();
    await loadHighScoresForGame(gameId);
    await loadModsForGame(gameId);
    await loadPingolfTargetsForGame(gameId);
    await renderPingolfAdmin();
    await loadPartiesDirectory();
    resetAiProposalUi();
    var ps = document.getElementById("mg-party-link-select");
    if (ps) ps.value = g.partyId ? String(g.partyId) : "";
    var prelPub = document.getElementById("mg-party-relationship-public");
    if (prelPub) prelPub.value = g.partyRelationshipPublic || "";
    var ghOwn = document.getElementById("mg-game-hide-owner-public");
    if (ghOwn) ghOwn.checked = g.hideOwnerPublic === true;
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

      await persistPartyLinkFromForm(savedGameId);

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
    await onSaveStint("", "Haines St", "8908", "", "", "");
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
    if (catalogLoaded) return;
    if (catalogLoadPromise) return catalogLoadPromise;
    catalogLoadPromise = (async function () {
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
        await loadPartiesDirectory();
        enterIdleMode("Loaded " + gamesCache.length + " games.");
      } catch (err) {
        catalogLoaded = false;
        setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
      } finally {
        catalogLoadPromise = null;
      }
    })();
    return catalogLoadPromise;
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
    appEl.appendChild(buildForm());
    appEl.appendChild(buildPartiesMainStrip());
    document.addEventListener("click", onMemberGamesDocumentClick);
    syncPartyDirectoryDeleteVisibility();
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
      void loadCatalog();
    } else {
      refreshFeaturedPingolfSession().then(function () {
        if (currentGameId) return loadPingolfTargetsForGame(currentGameId);
      });
      renderPingolfAdmin();
      syncPartyDirectoryDeleteVisibility();
      void loadPartiesDirectory();
      setMode(mode);
    }
  }

  async function openGameForEdit(gameId, hintRoles) {
    var roles = hintRoles || lastUserRoles;
    if (!gameId || !window.SNHMemberPortal) return;
    if (!window.SNHMemberPortal.memberHasAnyRole(roles || [], GAMES_ROLE_CSV)) return;

    lastUserRoles = roles || lastUserRoles;

    if (!inited) {
      inited = true;
      buildShell();
    }
    await loadCatalog();
    if (!catalogLoaded) return;

    if (!confirmDiscardPartyIfDirty()) return;
    if (!confirmDiscardIfDirty()) return;
    await populateForm(String(gameId));
    setComboboxOpen(false);
  }

  window.SNHMemberGamesPanel = {
    onPanelShown: onPanelShown,
    openGameForEdit: openGameForEdit
  };
})();
