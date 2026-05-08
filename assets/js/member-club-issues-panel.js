(function () {
  var appEl = null;
  var statusEl = null;
  var listEl = null;
  var formWrap = null;
  var filterEl = null;
  var inited = false;
  var lastRoles = [];
  var editingId = null;
  var lastRows = [];
  var currentFilter = "open";
  var gameOptionsReady = false;

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "className") n.className = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
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
    var i = el("textarea", { id: id, className: "member-games-textarea", rows: "4" });
    i.value = value || "";
    return i;
  }

  function canEditClubIssues() {
    return Array.isArray(lastRoles) && lastRoles.length > 0;
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function resetForm() {
    editingId = null;
    var t = document.getElementById("ci-title");
    var b = document.getElementById("ci-body");
    var g = document.getElementById("ci-game-select");
    var s = document.getElementById("ci-status");
    if (t) t.value = "";
    if (b) b.value = "";
    if (g) g.value = "";
    if (s) s.value = "open";
    var sub = document.getElementById("ci-submit");
    if (sub) sub.textContent = "Add issue";
  }

  function syncFormVisibility() {
    if (!formWrap) return;
    formWrap.hidden = !canEditClubIssues();
  }

  async function ensureGameOptions() {
    if (gameOptionsReady || !window.SNHMemberPortal || !window.SNHMemberPortal.clubIssuesGameOptions) return;
    var sel = document.getElementById("ci-game-select");
    if (!sel) return;
    try {
      var games = await window.SNHMemberPortal.clubIssuesGameOptions();
      var arr = Array.isArray(games) ? games : [];
      while (sel.options.length > 1) {
        sel.remove(1);
      }
      arr.forEach(function (g) {
        if (!g || !g.id) return;
        var opt = el("option", { value: g.id });
        opt.textContent = g.title || g.slug || String(g.id);
        sel.appendChild(opt);
      });
      gameOptionsReady = true;
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  function buildFilterBar() {
    var wrap = el("div", {
      className: "member-club-issues-filter",
      role: "group",
      "aria-label": "Filter by status"
    });
    var label = el("span", { className: "member-club-issues-filter-label", text: "Show:" });
    wrap.appendChild(label);
    [
      { key: "all", text: "All" },
      { key: "open", text: "Incoming" },
      { key: "in_progress", text: "In progress" },
      { key: "resolved", text: "Resolved" }
    ].forEach(function (opt) {
      var btn = el("button", {
        type: "button",
        className: "members-sidebar-link member-club-issues-filter-btn",
        "data-ci-filter": opt.key
      });
      btn.textContent = opt.text;
      if (opt.key === currentFilter) btn.setAttribute("aria-current", "true");
      btn.addEventListener("click", function () {
        currentFilter = opt.key;
        wrap.querySelectorAll(".member-club-issues-filter-btn").forEach(function (b) {
          b.removeAttribute("aria-current");
        });
        btn.setAttribute("aria-current", "true");
        renderIssueList();
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function buildShell() {
    appEl = document.getElementById("member-club-issues-app");
    if (!appEl) return;
    appEl.replaceChildren();
    statusEl = el("p", {
      className: "member-games-status",
      id: "member-club-issues-status",
      role: "status",
      "aria-live": "polite"
    });
    filterEl = buildFilterBar();
    listEl = el("div", { className: "member-club-issues-list" });
    formWrap = el("div", { className: "member-club-issues-form member-games-form" });
    formWrap.appendChild(el("h4", { text: "Add or edit issue" }));
    formWrap.appendChild(fieldRow("Title", textInput("ci-title", "")));
    formWrap.appendChild(fieldRow("Details", textareaInput("ci-body", "")));

    var gameSel = el("select", { id: "ci-game-select", className: "member-games-input" });
    var blankOpt = el("option", { value: "" });
    blankOpt.textContent = "Not linked to a catalog game";
    gameSel.appendChild(blankOpt);
    formWrap.appendChild(fieldRow("Catalog game", gameSel));

    var sel = el("select", { id: "ci-status", className: "member-games-input" });
    ["open", "in_progress", "resolved"].forEach(function (v) {
      var opt = el("option", { value: v });
      opt.textContent = formatIssueStatusLabel(v);
      sel.appendChild(opt);
    });
    formWrap.appendChild(fieldRow("Status", sel));
    var sub = el("button", { type: "button", className: "members-sidebar-link", id: "ci-submit" });
    sub.textContent = "Add issue";
    sub.addEventListener("click", onSubmit);
    var clr = el("button", { type: "button", className: "members-sidebar-link", id: "ci-clear" });
    clr.textContent = "Clear form";
    clr.addEventListener("click", function () {
      resetForm();
      setStatus("Form cleared.");
    });
    formWrap.appendChild(el("div", { className: "member-games-form-actions" }, [sub, clr]));

    appEl.appendChild(statusEl);
    appEl.appendChild(filterEl);
    appEl.appendChild(listEl);
    appEl.appendChild(formWrap);
    syncFormVisibility();
  }

  async function onSubmit() {
    if (!window.SNHMemberPortal || !canEditClubIssues()) return;
    var titleEl = document.getElementById("ci-title");
    var title = titleEl ? String(titleEl.value || "").trim() : "";
    if (!title) {
      setStatus("Title is required.");
      return;
    }
    var bodyEl = document.getElementById("ci-body");
    var gidEl = document.getElementById("ci-game-select");
    var stEl = document.getElementById("ci-status");
    var body = bodyEl ? String(bodyEl.value || "").trim() : "";
    var gid = gidEl ? String(gidEl.value || "").trim() : "";
    var st = stEl ? String(stEl.value || "open") : "open";
    var fields = {
      title: title,
      body: body || null,
      status: st,
      gameId: gid || null
    };
    setStatus("Saving…");
    try {
      await window.SNHMemberPortal.clubIssuesUpsert(editingId, fields);
      resetForm();
      await loadList();
      setStatus("Saved.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  function formatIssueDate(iso) {
    if (!iso || !window.SNHMemberPortal || !window.SNHMemberPortal.formatDate) return "";
    return window.SNHMemberPortal.formatDate(iso);
  }

  /** Display labels (stored status values remain open | in_progress | resolved). */
  function formatIssueStatusLabel(raw) {
    var s = String(raw || "open").toLowerCase();
    if (s === "open") return "Incoming";
    if (s === "in_progress") return "In progress";
    if (s === "resolved") return "Resolved";
    return s.replace(/_/g, " ");
  }

  function canEditGameCatalog() {
    if (!window.SNHMemberPortal || !Array.isArray(lastRoles)) return false;
    var grp =
      (window.SNHMemberPortal.ROLE_GROUPS && window.SNHMemberPortal.ROLE_GROUPS.GAMES_ACCESS) ||
      ["games_editor", "games_admin", "club_admin"];
    var csv =
      window.SNHMemberPortal.rolesToCsv && window.SNHMemberPortal.rolesToCsv(grp);
    return window.SNHMemberPortal.memberHasAnyRole(lastRoles, csv || "games_editor,games_admin,club_admin");
  }

  function gameSummaryLine(row) {
    var gid = row.gameId || row.game_id;
    var gTitle = row.gameTitle;
    var gSlug = row.gameSlug;
    if (gTitle) {
      var span = el("span", { className: "member-club-issues-game-name", text: gTitle });
      var bits = [span];
      if (gid && canEditGameCatalog()) {
        var editA = el("a", {
          href: "#",
          className: "member-club-issues-game-link",
          text: "Edit game"
        });
        editA.addEventListener("click", function (ev) {
          ev.preventDefault();
          if (window.snhNavigateToMemberGameEditor) {
            window.snhNavigateToMemberGameEditor(gid);
          }
        });
        bits.push(document.createTextNode(" · "));
        bits.push(editA);
      } else if (gSlug) {
        var pub = el("a", {
          href: "games.html",
          className: "member-club-issues-game-link",
          text: "Games page"
        });
        bits.push(document.createTextNode(" · "));
        bits.push(pub);
      }
      return el("span", {}, bits);
    }
    if (gid) {
      return el("span", {
        className: "member-club-issues-unlinked",
        text: "Linked (catalog row unavailable)"
      });
    }
    return el("span", {
      className: "member-club-issues-unlinked",
      text: "Not linked to catalog"
    });
  }

  function appendQuickActions(card, row) {
    if (!canEditClubIssues() || !row.id) return;
    var st = String(row.status || "open").toLowerCase();
    var actions = el("div", { className: "member-club-issues-quick-actions" });

    function mk(label, next) {
      var b = el("button", { type: "button", className: "members-sidebar-link member-club-issues-quick-btn" });
      b.textContent = label;
      b.addEventListener("click", function () {
        quickStatus(row, next);
      });
      actions.appendChild(b);
    }

    if (st === "open") {
      mk("Mark in progress", "in_progress");
      mk("Resolve", "resolved");
    } else if (st === "in_progress") {
      mk("Back to incoming", "open");
      mk("Resolve", "resolved");
    } else if (st === "resolved") {
      mk("Mark incoming", "open");
    }

    if (actions.childNodes.length) card.appendChild(actions);
  }

  async function quickStatus(row, nextStatus) {
    if (!window.SNHMemberPortal || !canEditClubIssues() || !row || !row.id) return;
    setStatus("Updating…");
    try {
      await window.SNHMemberPortal.clubIssuesUpsert(row.id, {
        title: row.title,
        status: nextStatus
      });
      await loadList();
      setStatus("Updated.");
    } catch (err) {
      setStatus(window.SNHMemberPortal.getFriendlyAuthErrorMessage(err));
    }
  }

  function renderIssueList() {
    if (!listEl) return;
    listEl.replaceChildren();
    var filtered = lastRows.filter(function (r) {
      if (currentFilter === "all") return true;
      return String(r.status || "").toLowerCase() === currentFilter;
    });
    if (filtered.length === 0) {
      listEl.appendChild(
        el("p", {
          className: "member-games-help",
          text: lastRows.length === 0 ? "No issues logged yet." : "No issues match this filter."
        })
      );
      return;
    }
    filtered.forEach(function (row) {
      var card = el("article", { className: "member-club-issues-card" });
      card.appendChild(el("h4", { text: row.title || "(untitled)" }));
      var meta = el("p", { className: "member-club-issues-meta" });
      var submittedIso = row.submittedAt || row.createdAt;
      var metaParts = [];
      if (submittedIso) metaParts.push("Submitted " + formatIssueDate(submittedIso));
      metaParts.push(formatIssueStatusLabel(row.status));
      meta.appendChild(document.createTextNode(metaParts.join(" · ") + " · "));
      meta.appendChild(gameSummaryLine(row));
      card.appendChild(meta);
      var subForCmp = row.submittedAt || row.createdAt;
      if (row.updatedAt && subForCmp && String(row.updatedAt) !== String(subForCmp)) {
        card.appendChild(
          el("p", {
            className: "member-club-issues-updated",
            text: "Last updated " + formatIssueDate(row.updatedAt)
          })
        );
      }
      if (row.body) {
        card.appendChild(el("p", { className: "member-club-issues-body", text: row.body }));
      }
      appendQuickActions(card, row);
      if (canEditClubIssues() && row.id) {
        var edit = el("button", { type: "button", className: "members-sidebar-link" });
        edit.textContent = "Edit";
        edit.addEventListener("click", function () {
          startEdit(row);
        });
        card.appendChild(edit);
      }
      listEl.appendChild(card);
    });
  }

  async function loadList() {
    if (!listEl || !window.SNHMemberPortal) return;
    setStatus("Loading issues…");
    try {
      var rows = await window.SNHMemberPortal.clubIssuesList();
      var arr = Array.isArray(rows) ? rows : [];
      lastRows = arr;
      renderIssueList();
      setStatus("Loaded " + arr.length + " issue(s).");
    } catch (err) {
      listEl.replaceChildren();
      listEl.appendChild(
        el("p", {
          className: "members-page-status",
          text: window.SNHMemberPortal.getFriendlyAuthErrorMessage(err)
        })
      );
      setStatus("Could not load issues.");
    }
  }

  async function startEdit(row) {
    if (!row || !canEditClubIssues()) return;
    await ensureGameOptions();
    editingId = row.id;
    var t = document.getElementById("ci-title");
    var b = document.getElementById("ci-body");
    var g = document.getElementById("ci-game-select");
    var s = document.getElementById("ci-status");
    if (t) t.value = row.title || "";
    if (b) b.value = row.body || "";
    if (g) g.value = row.gameId || row.game_id || "";
    if (s) s.value = String(row.status || "open").toLowerCase();
    var sub = document.getElementById("ci-submit");
    if (sub) sub.textContent = "Update issue";
    setStatus("Editing selected issue. Adjust fields and save.");
    if (formWrap && !formWrap.hidden) {
      formWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  window.SNHMemberClubIssuesPanel = {
    onPanelShown: function (roles) {
      lastRoles = roles || [];
      if (!window.SNHMemberPortal || !window.SNHMemberPortal.clubIssuesList) return;
      if (!inited) {
        inited = true;
        buildShell();
      } else {
        syncFormVisibility();
      }
      if (canEditClubIssues()) {
        ensureGameOptions();
      }
      loadList();
    }
  };
})();
