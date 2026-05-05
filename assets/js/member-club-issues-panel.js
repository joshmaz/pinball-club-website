(function () {
  var GAMES_EDIT_CSV =
    (window.SNHMemberPortal &&
      window.SNHMemberPortal.rolesToCsv &&
      window.SNHMemberPortal.rolesToCsv(
        (window.SNHMemberPortal.ROLE_GROUPS && window.SNHMemberPortal.ROLE_GROUPS.GAMES_ACCESS) ||
          ["games_editor", "games_admin", "club_admin"]
      )) ||
    "games_editor,games_admin,club_admin";

  var appEl = null;
  var statusEl = null;
  var listEl = null;
  var formWrap = null;
  var inited = false;
  var lastRoles = [];
  var editingId = null;

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

  function hasGamesEdit() {
    return !!(
      window.SNHMemberPortal &&
      window.SNHMemberPortal.memberHasAnyRole &&
      window.SNHMemberPortal.memberHasAnyRole(lastRoles || [], GAMES_EDIT_CSV)
    );
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function resetForm() {
    editingId = null;
    var t = document.getElementById("ci-title");
    var b = document.getElementById("ci-body");
    var g = document.getElementById("ci-game-id");
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
    formWrap.hidden = !hasGamesEdit();
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
    listEl = el("div", { className: "member-club-issues-list" });
    formWrap = el("div", { className: "member-club-issues-form member-games-form" });
    formWrap.appendChild(el("h4", { text: "Add or edit issue" }));
    formWrap.appendChild(fieldRow("Title", textInput("ci-title", "")));
    formWrap.appendChild(fieldRow("Details", textareaInput("ci-body", "")));
    formWrap.appendChild(fieldRow("Game id (optional uuid)", textInput("ci-game-id", "")));
    var sel = el("select", { id: "ci-status", className: "member-games-input" });
    ["open", "in_progress", "resolved"].forEach(function (v) {
      var opt = el("option", { value: v });
      opt.textContent = v.replace(/_/g, " ");
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
    appEl.appendChild(listEl);
    appEl.appendChild(formWrap);
    syncFormVisibility();
  }

  async function onSubmit() {
    if (!window.SNHMemberPortal || !hasGamesEdit()) return;
    var titleEl = document.getElementById("ci-title");
    var title = titleEl ? String(titleEl.value || "").trim() : "";
    if (!title) {
      setStatus("Title is required.");
      return;
    }
    var bodyEl = document.getElementById("ci-body");
    var gidEl = document.getElementById("ci-game-id");
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

  async function loadList() {
    if (!listEl || !window.SNHMemberPortal) return;
    listEl.replaceChildren();
    setStatus("Loading issues…");
    try {
      var rows = await window.SNHMemberPortal.clubIssuesList();
      var arr = Array.isArray(rows) ? rows : [];
      if (arr.length === 0) {
        listEl.appendChild(el("p", { className: "member-games-help", text: "No issues logged yet." }));
      } else {
        arr.forEach(function (row) {
          var card = el("article", { className: "member-club-issues-card" });
          card.appendChild(el("h4", { text: row.title || "(untitled)" }));
          var meta = el("p", { className: "member-club-issues-meta" });
          meta.textContent =
            (row.status || "") +
            (row.gameId ? " · game " + String(row.gameId).slice(0, 8) + "…" : " · club-wide") +
            (row.createdAt ? " · " + row.createdAt : "");
          card.appendChild(meta);
          if (row.body) {
            card.appendChild(el("p", { text: row.body }));
          }
          if (hasGamesEdit() && row.id) {
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
      setStatus("Loaded " + arr.length + " issue(s).");
    } catch (err) {
      listEl.appendChild(
        el("p", {
          className: "members-page-status",
          text: window.SNHMemberPortal.getFriendlyAuthErrorMessage(err)
        })
      );
      setStatus("Could not load issues.");
    }
  }

  function startEdit(row) {
    if (!row || !hasGamesEdit()) return;
    editingId = row.id;
    var t = document.getElementById("ci-title");
    var b = document.getElementById("ci-body");
    var g = document.getElementById("ci-game-id");
    var s = document.getElementById("ci-status");
    if (t) t.value = row.title || "";
    if (b) b.value = row.body || "";
    if (g) g.value = row.gameId || "";
    if (s) s.value = String(row.status || "open").toLowerCase();
    var sub = document.getElementById("ci-submit");
    if (sub) sub.textContent = "Update issue";
    setStatus("Editing selected issue — adjust fields and save.");
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
      loadList();
    }
  };
})();
