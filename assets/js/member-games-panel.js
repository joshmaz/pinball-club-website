Warning: truncated output (original token count: 34826)
Total output lines: 3286

(function () {
  var MAX_AI_CONTEXT_CHARS = 15000;
  var GAMES_ROLE_CSV =
    (window.SNHMemberPortal && window.SNHMemberPortal.rolesToCsv && window.SNHMemberPortal.rolesToCsv(
      (window.SNHMemberPortal.ROLE_GROUPS && window.SNHMemberPortal.ROLE_GROUPS.GAMES_ACCESS) ||
        ["games_editor", "games_admin", "club_admin"]
    )) || "games_editor,games_admin,club_admin";

  var appEl = null;
  var statusEl = null;
  var comboboxInputEl = null;
  var comboboxClearEl = null;
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
  var imagesWrapEl = null;
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
  var deleteWrapEl = null;
  var moreToolsEl = null;
  var softDeleteBtnEl = null;
  var restoreBtnEl = null;
  var highScoresWrapEl = null;
  var modsWrapEl = null;
  var pingolfTargetsWrapEl = null;
  var editingPingolfTargetId = null;
  var pingolfTargetCount = 0;
  var pingolfBusy = false;
  var pingolfLoaded = false;
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
  var aiSourceStatusEl = null;
  var aiProposalBodyEl = null;
  var aiSourceProposalBodyEl = null;
  var aiApplyBtnEl = null;
  var aiProposalData = null;
  var aiDescriptionRegenCount = 0;
  var aiOperatorVerifiedSourcesByGame = Object.create(null);
  var aiBusy = false;
  var filterAtClubOnly = false;
  var pinballMapIngestStatusRowEl = null;
  var pinballMapIngestBtnEl = null;
  var pinballMapIngestBusy = false;
  var imageUploadBusy = false;
  var gameSaveBusy = false;
  var gameSaveFeedbackTimer = null;
  var gamesWorkspaceTabButtons = Object.create(null);
  var gamesWorkspacePanels = Object.create(null);

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
    var topSaveBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-save-top" });
    topSaveBtn.textContent = "Save changes";
    var topActions = el("div", { className: "member-games-sticky-actions" }, [topSaveBtn]);
    formEl.appendChild(topActions);
    var libraryLink = el("a", { id: "mg-library-link", className: "member-games-help", href: "games.html", hidden: "hidden", text: "View in Games Library" });
    libraryLink.addEventListener("click", function (event) {
      if (!confirmDiscardIfDirty()) event.preventDefault();
    });
    topSaveBtn.addEventListener("click", onSaveGame);
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
    formEl.appendChild(buildGameImagesSection());
    var metadataPanel = el("div", { className: "member-games-metadata member-games-collapsible-panel" });
    metadataPanel.appendChild(el("p", { className: "member-games-help", text: "Game information" }));
    metadataPanel.appendChild(fieldRow("Page URL slug", textInput("mg-slug", "")));
    metadataPanel.appendChild(el("p", { className: "member-games-help", text: "This identifies the game’s public page URL. New games use the title when this is blank; existing slugs are read-only." }));
    metadataPanel.appendChild(
      fieldRow(
        "Release date",
        dateInput("mg-release", "")
      )
    );
    metadataPanel.appendChild(
      fieldRow(
        "Manufacture date",
        dateInput("mg-mfg", "")
      )
    );
    metadataPanel.appendChild(
      fieldRow(
        "Manufacturer",
        textInput("mg-mfr", "")
      )
    );
    metadataPanel.appendChild(
      fieldRow(
        "Manufacturer full name",
        textInput("mg-mfrfull", "")
      )
    );
    metadataPanel.appendChild(
      fieldRow(
        "Type (em|ss|…)",
        textInput("mg-type", "")
      )
    );
    metadataPanel.appendChild(
      fieldRow(
        "Display",
        textInput("mg-display", "")
      )
    );
    metadataPanel.appendChild(
      fieldRow(
        "Player count",
        numberInput("mg-players", "")
      )
    );
    var sourceMetadataPanel = el("div", { className: "member-games-metadata member-games-collapsible-panel" });
    sourceMetadataPanel.appendChild(el("p", { className: "member-games-help", text: "Imported identity and Pinball Map status are shown for reference. Update them through their source integration." }));
    sourceMetadataPanel.appendChild(el("p", { className: "member-games-help", text: "OPDB · imported and read-only" }));
    sourceMetadataPanel.appendChild(
      fieldRow(
        "OPDB id",
        el("input", { type: "text", id: "mg-opdb", className: "member-games-input", readOnly: "readonly", "aria-readonly": "true" })
      )
    );
    sourceMetadataPanel.appendChild(
      fieldRow(
        "OPDB matched via",
        el("input", { type: "text", id: "mg-opdbvia", className: "member-games-input", readOnly: "readonly", "aria-readonly": "true" })
      )
    );
    sourceMetadataPanel.appendChild(
      fieldRow(
        "OPDB canonical name",
        el("input", { type: "text", id: "mg-opdbcanon", className: "member-games-input", readOnly: "readonly", "aria-readonly": "true" })
      )
    );

    sourceMetadataPanel.appendChild(el("p", { className: "member-games-help", text: "Pinball Map status" }));
    var mapRow = el("p", { className: "member-games-meta" });
    mapRow.appendChild(el("strong", { text: "Map at club (read-only): " }));
    mapRow.appendChild(el("span", { id: "mg-map-at", text: "—" }));
    sourceMetadataPanel.appendChild(mapRow);

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
    sourceMetadataPanel.appendChild(manualWrapEl);
    metadataPanel.appendChild(wrapCollapsible("Imported & location data", sourceMetadataPanel));
    formEl.appendChild(wrapCollapsible("Game metadata", metadataPanel));

    var linksPanel = el("div", { className: "member-games-metadata member-games-collapsible-panel" });
    linksPanel.appendChild(el("p", { className: "member-games-help", text: "Links to external game references. Open and confirm a page before applying a suggested URL." }));
    linksPanel.appendChild(fieldRow("Pinside URL", textInput("mg-pinside", "")));
    linksPanel.appendChild(fieldRow("IPDB URL", textInput("mg-ipdb", "")));
    linksPanel.appendChild(fieldRow("Kineticist URL", textInput("mg-kineticist", "")));
    linksPanel.appendChild(buildSourceAssistantScaffold());
    formEl.appendChild(wrapCollapsible("Third-party links", linksPanel));

    formEl.appendChild(buildReviewScaffolds());
    formEl.appendChild(fieldRow(
      "Brief public description of our machine",
      textareaInput("mg-details", "")
    ));
    formEl.appendChild(el("p", { className: "member-games-help", text: "Shown on the game card and About our machine. Keep it brief, specific, and supported by evidence." }));

    stintsEl = el("div", { className: "member-games-stints member-games-collapsible-panel" });
    stintsSectionEl = wrapCollapsible("Location stints", stintsEl);

    var salePanel = el("div", { className: "member-games-sale member-games-collapsible-panel" });
    salePanel.appendChild(fieldRow("Status", textInput("mg-sale-status", "draft")));
    salePanel.appendChild(fieldRow("Asking price (cents)", numberInput("mg-sale-cents", "")));
    salePanel.appendChild(fieldRow("Notes", textareaInput("mg-sale-notes", "")));
    saleEl = wrapCollapsible("For sale listing", salePanel);

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

    var pingolfPanel = el("div", { className: "member-games-extended member-games-collapsible-panel", id: "mg-pingolf-targets-wrap" });
    pingolfPanel.appendChild(el("p", { className: "member-games-help", id: "mg-pingolf-help", text: "" }));
    pingolfPanel.appendChild(el("div", { id: "mg-pingolf-target-list", className: "member-games-sublist" }));
    pingolfPanel.appendChild(fieldRow("Target description", textInput("mg-pg-desc", "")));
    var pgType = el("select", { id: "mg-pg-type" });
    ["score", "feature", "progression", "hybrid"].forEach(function (type) {
      pgType.appendChild(el("option", { value: type, text: type.charAt(0).toUpperCase() + type.slice(1) }));
    });
    pingolfPanel.appendChild(fieldRow("Target type", pgType));
    var pgScore = textInput("mg-pg-val", "");
    pgScore.inputMode = "numeric";
    pingolfPanel.appendChild(fieldRow("Score threshold (optional)", pgScore));
    pingolfPanel.appendChild(fieldRow("Internal notes", textInput("mg-pg-notes", "")));
    pingolfPanel.appendChild(fieldRow("Preferred target", el("input", { type: "checkbox", id: "mg-pg-preferred" })));
    var pgAdd = el("button", { type: "button", className: "members-sidebar-link", id: "mg-pg-add" });
    pgAdd.textContent = "Add Pingolf target";
    pgAdd.addEventListener("click", onAddPingolfTarget);
    pingolfPanel.appendChild(pgAdd);
    var pgCancel = el("button", { type: "button", className: "members-sidebar-link", id: "mg-pg-cancel", text: "Cancel target edit" });
    pgCancel.hidden = true;
    pgCancel.addEventListener("click", resetPingolfForm);
    pingolfPanel.appendChild(pgCancel);
    pingolfPanel.querySelectorAll(".member-games-field").forEach(function (row) {
      var label = row.querySelector("label");
      var input = row.querySelector("input, select");
      if (label && input) label.setAttribute("for", input.id);
    });
    pingolfTargetsWrapEl = wrapCollapsible("Pingolf Targets", pingolfPanel);

    var moreToolsPanel = el("div", { className: "member-games-more-tools" });
    moreToolsPanel.appendChild(el("p", { className: "member-games-help", text: "Less frequently used tools for this game." }));
    moreToolsPanel.appendChild(stintsSectionEl);
    moreToolsPanel.appendChild(saleEl);
    moreToolsPanel.appendChild(highScoresWrapEl);
    moreToolsPanel.appendChild(modsWrapEl);
    moreToolsPanel.appendChild(pingolfTargetsWrapEl);
    moreToolsEl = wrapCollapsible("More game tools", moreToolsPanel);
    formEl.appendChild(moreToolsEl);

    var saveBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-save" });
    saveBtn.textContent = "Save game";
    var cancelBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-cancel" });
    cancelBtn.textContent = "Cancel";
    var actions = el("div", { className: "member-games-form-actions" }, [saveBtn, cancelBtn]);
    formEl.appendChild(actions);
    formEl.appendChild(libraryLink);
    var deletePanel = el("div", { className: "member-games-delete-panel" });
    deletePanel.appendChild(deleteStatusEl);
    deletePanel.appendChild(deleteNoteRow);
    deletePanel.appendChild(deleteActions);
    deleteWrapEl = wrapCollapsible("Game administration", deletePanel);
    formEl.appendChild(deleteWrapEl);

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

  function setGameSaveButtonsState(state) {
    if (gameSaveFeedbackTimer) {
      window.clearTimeout(gameSaveFeedbackTimer);
      gameSaveFeedbackTimer = null;
    }
    ["mg-save-top", "mg-save"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.classList.toggle("is-success", state === "success");
      btn.classList.toggle("is-error", state === "error");
      btn.disabled = state === "busy";
      if (state === "busy") btn.setAttribute("aria-busy", "true");
      else btn.removeAttribute("aria-busy");
      if (state === "busy") btn.textContent = "Saving…";
      else if (state === "success") btn.textContent = "Saved ✓";
      else if (state === "error") btn.textContent = "Save failed";
      else btn.textContent = id === "mg-save-top" ? "Save changes" : "Save game";
    });
    if (state === "success" || state === "error") {
      gameSaveFeedbackTimer = window.setTimeout(function () {
        setGameSaveButtonsState("idle");
      }, 1800);
    }
  }

  function onFormPotentiallyDirty(event) {
    if (suppressDirtyTracking) return;
    if (event && event.target && event.target.closest && event.target.closest(".member-games-review-scaffolds")) return;
    if (mode === "edit" || mode === "new") isDirty = true;
  }

  function buildGameImagesSection() {
    var panel = el("div", { className: "member-games-images member-games-collapsible-panel" });
    panel.appendChild(
      el("p", {
        className: "member-games-help",
        text:
          "Club images are approved immediately. OPDB images are imported with provenance as reference-only until an editor explicitly approves one. Choosing a club image does not remove OPDB associations."
      })
    );
    panel.appendChild(el("div", { id: "mg-images-list", className: "member-games-images-list" }));

    var syncBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-image-sync-opdb" });
    syncBtn.textContent = "Sync images from OPDB";
    syncBtn.addEventListener("click", onSyncOpdbImages);
    panel.appendChild(syncBtn);

    var localHelp = el("p", {
      className: "member-games-help",
      text:
        "Upload a club-owned JPEG, PNG, WebP, or GIF (maximum 10 MB). Photos are stored in Supabase and can coexist with other club and external images."
    });
    panel.appendChild(localHelp);
    panel.appendChild(fieldRow("Club photo", el("input", {
      type: "file",
      id: "mg-image-file",
      className: "member-games-input",
      accept: "image/jpeg,image/png,image/webp,image/gif"
    })));
    panel.appendChild(fieldRow("Alt text (optional)", textInput("mg-image-alt", "")));
    var primaryRow = el("div", { className: "member-games-field member-games-checkbox-row" });
    var primaryCheckbox = el("input", { type: "checkbox", id: "mg-image-make-primary" });
    primaryCheckbox.checked = true;
    primaryRow.appendChild(primaryCheckbox);
    primaryRow.appendChild(el("label", { for: "mg-image-make-primary", text: "Use this photo as the primary image" }));
    panel.appendChild(primaryRow);
    var addBtn = el("button", { type: "button", className: "members-sidebar-link", id: "mg-image-add-club" });
    addBtn.textContent = "Upload club photo";
    addBtn.addEventListener("click", onAddClubImage);
    panel.appendChild(addBtn);

    imagesWrapEl = wrapCollapsible("Images", panel);
    imagesWrapEl.addEventListener("input", function (event) {
      event.stopPropagation();
    });
    imagesWrapEl.addEventListener("change", function (event) {
      event.stopPropagation();
    });
    return imagesWrapEl;
  }

  function renderGameImages(images) {
    var list = document.getElementById("mg-images-list");
    if (!list) return;
    list.replaceChildren();
    var rows = Array.isArray(images) ? images : [];
    if (!rows.length) {
      list.appendChild(el("p", { className: "member-games-help", text: "No image associations yet." }));
      return;
    }

    rows.forEach(function (imageRow) {
      var card = el("div", { className: "member-games-image-card" });
      var previewUrl = String(imageRow.displayUrl || imageRow.locationValue || "").trim();
      if (previewUrl) {
        card.appendChild(
          el("img", {
            className: "member-games-image-preview",
            src: previewUrl,
            alt: String(imageRow.altText || "Game image preview")
          })
        );
      }
      var preview = card.querySelector("img");
      if (preview) window.SNHGameImages.apply(preview, imageRow, false);
      var sourceLabel = imageRow.sourceType === "club" ? "Club-owned" : String(imageRow.sourceType || "External").toUpperCase();
      var isUploadedClubImage = imageRow.sourceType === "club" && imageRow.metadata && imageRow.metadata.storagePath;
      if (isUploadedClubImage) sourceLabel += " upload";
      else if (imageRow.sourceType === "club" && imageRow.locationType === "local_asset") sourceLabel += " legacy asset";
      var stateLabel = imageRow.usageStatus === "approved" ? "approved for display" : "reference…22826 tokens truncated…  line.appendChild(del);
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

  function syncPingolfControls() {
    var add = document.getElementById("mg-pg-add");
    if (add) {
      add.textContent = editingPingolfTargetId ? "Save target" : "Add target";
      add.disabled = pingolfBusy || !pingolfLoaded || (!editingPingolfTargetId && pingolfTargetCount >= 10);
    }
    var cancel = document.getElementById("mg-pg-cancel");
    if (cancel) { cancel.hidden = !editingPingolfTargetId; cancel.disabled = pingolfBusy; }
    var box = document.getElementById("mg-pingolf-target-list");
    if (box) box.querySelectorAll("button").forEach(function (button) { button.disabled = pingolfBusy; });
  }

  function resetPingolfForm() {
    editingPingolfTargetId = null;
    ["mg-pg-desc", "mg-pg-val", "mg-pg-notes"].forEach(function (id) {
      var input = document.getElementById(id);
      if (input) input.value = "";
    });
    var type = document.getElementById("mg-pg-type");
    if (type) type.value = "feature";
    var preferred = document.getElementById("mg-pg-preferred");
    if (preferred) preferred.checked = false;
    syncPingolfControls();
  }

  async function loadPingolfTargetsForGame(gameId) {
    var box = document.getElementById("mg-pingolf-target-list");
    var help = document.getElementById("mg-pingolf-help");
    if (!box || !window.SNHMemberPortal) return;
    pingolfLoaded = false;
    syncPingolfControls();
    try {
      var targets = await window.SNHMemberPortal.pingolfTargetsListEditor(gameId);
      if (currentGameId !== gameId) return;
      var arr = Array.isArray(targets) ? targets : [];
      pingolfTargetCount = arr.length;
      pingolfLoaded = true;
      if (help) help.textContent = arr.length + " of 10 targets" + (arr.length >= 10 ? ". Limit reached. You can still edit existing targets." : ". Reusable objectives for this game.");
      renderPingolfTargets(arr);
    } catch (e) {
      if (currentGameId !== gameId) return;
      box.textContent = "Could not load Pingolf targets.";
      if (help) help.textContent = "Reopen this game to try again.";
    }
    syncPingolfControls();
  }

  function renderPingolfTargets(arr) {
    var box = document.getElementById("mg-pingolf-target-list");
    if (!box) return;
    box.replaceChildren();
    arr.forEach(function (row) {
      var line = el("div", { className: "member-games-sublist-row" });
      line.appendChild(el("span", { text: (row.isPreferred ? "★ Preferred · " : "") + row.description + " · " + row.targetType }));
      var edit = el("button", { type: "button", className: "members-sidebar-link", text: "Edit" });
      edit.addEventListener("click", function () {
        editingPingolfTargetId = row.id;
        document.getElementById("mg-pg-desc").value = row.description;
        document.getElementById("mg-pg-type").value = row.targetType;
        document.getElementById("mg-pg-val").value = row.scoreThreshold == null ? "" : row.scoreThreshold;
        document.getElementById("mg-pg-notes").value = row.notes || "";
        document.getElementById("mg-pg-preferred").checked = row.isPreferred;
        syncPingolfControls();
        document.getElementById("mg-pg-desc").focus();
      });
      line.appendChild(edit);
      var prefer = el("button", { type: "button", className: "members-sidebar-link", text: row.isPreferred ? "Clear preferred" : "Make preferred" });
      prefer.addEventListener("click", function () {
        void mutatePingolfTarget(function (gameId) {
          return window.SNHMemberPortal.pingolfTargetUpsert(row.id, gameId, { isPreferred: !row.isPreferred });
        }, "Preferred target updated.");
      });
      line.appendChild(prefer);
      if (hasDeleteAccess()) {
        var del = el("button", { type: "button", className: "members-sidebar-link", text: "Delete" });
        del.addEventListener("click", function () { void onDeletePingolfTarget(row.id); });
        line.appendChild(del);
      }
      box.appendChild(line);
    });
  }

  async function mutatePingolfTarget(action, message) {
    if (!currentGameId || pingolfBusy) return;
    var gameId = currentGameId;
    pingolfBusy = true;
    syncPingolfControls();
    try {
      await action(gameId);
      if (currentGameId !== gameId) return;
      resetPingolfForm();
      await loadPingolfTargetsForGame(gameId);
      setStatus(message);
    } catch (err) {
      if (currentGameId === gameId) setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    } finally {
      pingolfBusy = false;
      syncPingolfControls();
    }
  }

  async function onAddPingolfTarget() {
    if (!pingolfLoaded || (!editingPingolfTargetId && pingolfTargetCount >= 10)) return;
    var desc = getVal("mg-pg-desc");
    var score = getVal("mg-pg-val");
    if (!desc) { setStatus("Pingolf target description is required."); return; }
    if (score && (!/^[0-9]+$/.test(score) || BigInt(score) <= 0n || BigInt(score) > 9223372036854775807n)) {
      setStatus("Score threshold must be a positive whole number no larger than 9223372036854775807.");
      return;
    }
    var fields = {
      description: desc, targetType: getVal("mg-pg-type"), scoreThreshold: score || null,
      notes: getVal("mg-pg-notes") || null, isPreferred: document.getElementById("mg-pg-preferred").checked
    };
    var targetId = editingPingolfTargetId;
    await mutatePingolfTarget(function (gameId) {
      return window.SNHMemberPortal.pingolfTargetUpsert(targetId, gameId, fields);
    }, targetId ? "Pingolf target updated." : "Pingolf target added.");
  }

  async function onDeletePingolfTarget(targetId) {
    if (!hasDeleteAccess() || !targetId || !confirm("Delete this Pingolf target?")) return;
    await mutatePingolfTarget(function () { return window.SNHMemberPortal.pingolfTargetDelete(targetId); }, "Pingolf target deleted.");
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
    syncGameLibraryLink(null);
    currentGameId = gameId;
    pingolfLoaded = false;
    pingolfTargetCount = 0;
    resetPingolfForm();
    var pingolfList = document.getElementById("mg-pingolf-target-list");
    if (pingolfList) pingolfList.replaceChildren();
    var pingolfHelp = document.getElementById("mg-pingolf-help");
    if (pingolfHelp) pingolfHelp.textContent = "Loading targets…";
    var g = currentGame();
    if (!g) return;
    syncGameLibraryLink(g);
    if (window.SNHMemberRoutes) window.SNHMemberRoutes.setGame(g.id || gameId);
    if (comboboxInputEl) {
      comboboxInputEl.value = g.__label || g.title || g.slug || "";
      updateComboboxClearVisibility();
    }
    setMode("edit");
    suppressDirtyTracking = true;
    document.getElementById("mg-title").value = g.title || "";
    document.getElementById("mg-slug").value = g.slug || "";
    document.getElementById("mg-slug").readOnly = true;
    document.getElementById("mg-details").value = g.details || "";
    renderGameImages(g.images || []);
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
    await loadHighScoresForGame(gameId);
    await loadModsForGame(gameId);
    await loadPingolfTargetsForGame(gameId);
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
    if (gameSaveBusy) return;
    var title = getVal("mg-title");
    if (!title) {
      setStatus("Title is required.");
      setGameSaveButtonsState("error");
      return;
    }
    if (mode !== "new" && !currentGameId) {
      setStatus("Select a game first.");
      setGameSaveButtonsState("error");
      return;
    }
    var editingGame = mode === "edit" ? currentGame() : null;
    if (editingGame && isGameDeleted(editingGame)) {
      setStatus("Restore this game before saving metadata changes.");
      setGameSaveButtonsState("error");
      return;
    }
    gameSaveBusy = true;
    setGameSaveButtonsState("busy");
    setStatus("Saving…");
    try {
      var rd = getVal("mg-release");
      var md = getVal("mg-mfg");
      var fields = {
        title: getVal("mg-title"),
        slug: getVal("mg-slug") || undefined,
        details: getVal("mg-details"),
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
        // OPDB identity and match diagnostics are imported by the catalog integration, not edited here.
      };
      var savedGameId = currentGameId;
      if (mode === "new") {
        fields.slug = getVal("mg-slug") || slugify(title);
        savedGameId = await window.SNHMemberPortal.gamesCreate(fields);
      } else {
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
      setGameSaveButtonsState("success");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
      setGameSaveButtonsState("error");
    } finally {
      gameSaveBusy = false;
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
        await refreshPinballMapIngestStatus();
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
    appEl.appendChild(buildGamesWorkspaceTabs());
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
      if (currentGameId) void loadPingolfTargetsForGame(currentGameId);
      syncPartyDirectoryDeleteVisibility();
      void loadPartiesDirectory();
      void refreshPinballMapIngestStatus();
      setMode(mode);
    }
  }

  async function openGameForEdit(gameId, hintRoles) {
    var roles = hintRoles || lastUserRoles;
    if (!gameId || !window.SNHMemberPortal) return;
    if (!window.SNHMemberPortal.memberHasAnyRole(roles || [], GAMES_ROLE_CSV)) return;

    lastUserRoles = roles || lastUserRoles;
    activateGamesWorkspaceTab("games", false);

    if (!inited) {
      inited = true;
      buildShell();
    }
    await loadCatalog();
    if (!catalogLoaded) return;

    var requestedGame = gamesCache.find(function (game) {
      return game && String(game.id) === String(gameId);
    });
    if (!requestedGame) {
      if (window.SNHMemberRoutes) window.SNHMemberRoutes.setGame(null);
      setStatus("That game could not be found. Search for another game to edit.");
      return;
    }

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

