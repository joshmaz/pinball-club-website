(function () {
  var GAMES_ROLE_CSV =
    (window.SNHMemberPortal && window.SNHMemberPortal.rolesToCsv && window.SNHMemberPortal.rolesToCsv(
      (window.SNHMemberPortal.ROLE_GROUPS && window.SNHMemberPortal.ROLE_GROUPS.GAMES_ACCESS) ||
        ["games_editor", "games_admin", "club_admin"]
    )) || "games_editor,games_admin,club_admin";

  var appEl = null;
  var statusEl = null;
  var selectEl = null;
  var formEl = null;
  var stintsEl = null;
  var saleEl = null;
  var gamesCache = [];
  var currentGameId = null;
  var inited = false;
  var lastUserRoles = [];

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
    formEl = el("div", { className: "member-games-form", hidden: "hidden" });
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

    var manWrap = el("div", { className: "member-games-manual" });
    manWrap.appendChild(el("p", { className: "member-games-help", text: "Manual floor override (when Pinball Map is wrong or missing):" }));
    var manSel = el("select", { id: "mg-manual", className: "member-games-input" });
    ["follow_map", "force_on", "force_off"].forEach(function (v, idx) {
      var opt = el("option", { value: v });
      opt.textContent = ["Follow Pinball Map", "Force on floor", "Force not on floor"][idx];
      manSel.appendChild(opt);
    });
    manWrap.appendChild(fieldRow("Override", manSel));
    manWrap.appendChild(fieldRow("Override note", textInput("mg-manual-note", "")));
    formEl.appendChild(manWrap);

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
    formEl.appendChild(saveBtn);

    saveBtn.addEventListener("click", onSaveGame);

    return formEl;
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function getVal(id) {
    var n = document.getElementById(id);
    return n ? String(n.value || "").trim() : "";
  }

  function populateSelect() {
    if (!selectEl) return;
    selectEl.replaceChildren();
    var ph = el("option", { value: "" });
    ph.textContent = "Select a game…";
    selectEl.appendChild(ph);
    gamesCache.forEach(function (g) {
      var o = el("option", { value: g.id });
      o.textContent = g.title || g.slug || g.id;
      selectEl.appendChild(o);
    });
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
    var g = gamesCache.find(function (x) {
      return String(x.id) === String(gameId);
    });
    if (!g) return;
    formEl.hidden = false;
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
    renderStints(g.locationStints || []);
    await loadSale(gameId);
  }

  async function onSaveGame() {
    if (!currentGameId || !window.SNHMemberPortal) return;
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
      await window.SNHMemberPortal.gamesUpsert(currentGameId, fields);

      var m = document.getElementById("mg-manual");
      var mv = m ? m.value : "follow_map";
      if (mv === "follow_map") {
        await window.SNHMemberPortal.gamesClearManualAtClub(currentGameId);
      } else if (mv === "force_on") {
        await window.SNHMemberPortal.gamesSetManualAtClub(currentGameId, true, getVal("mg-manual-note") || null);
      } else {
        await window.SNHMemberPortal.gamesSetManualAtClub(currentGameId, false, getVal("mg-manual-note") || null);
      }

      await window.SNHMemberPortal.gamesSetSaleListing(currentGameId, {
        status: getVal("mg-sale-status") || "draft",
        asking_price_cents: getVal("mg-sale-cents") ? Number(getVal("mg-sale-cents")) : null,
        notes: getVal("mg-sale-notes") || null
      });

      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      populateSelect();
      selectEl.value = currentGameId;
      await populateForm(currentGameId);
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

  async function loadCatalog() {
    setStatus("Loading games catalog…");
    try {
      var data = await window.SNHMemberPortal.gamesEditorLoad();
      gamesCache = (data && data.games) || [];
      populateSelect();
      setStatus("Loaded " + gamesCache.length + " games.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  function buildShell() {
    appEl = document.getElementById("member-games-app");
    if (!appEl) return;
    appEl.replaceChildren();
    statusEl = el("p", { className: "member-games-status", id: "member-games-status" });
    selectEl = el("select", { id: "member-games-select", className: "member-games-select" });
    selectEl.addEventListener("change", function () {
      var id = selectEl.value;
      if (!id) {
        formEl.hidden = true;
        return;
      }
      populateForm(id);
    });
    appEl.appendChild(statusEl);
    appEl.appendChild(selectEl);
    appEl.appendChild(buildForm());
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
