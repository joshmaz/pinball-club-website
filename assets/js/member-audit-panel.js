(function () {
  var section, tableBody, status, moduleSelect, olderButton;
  var cursor = null;
  var initialized = false;
  var allowed = false;
  var loading = false;
  var pageSize = 50;
  var nextDetailId = 0;

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function same(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    var aKeys = Object.keys(a), bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every(function (key) {
      return Object.prototype.hasOwnProperty.call(b, key) && same(a[key], b[key]);
    });
  }

  function label(key) {
    var special = { id: "ID", url: "URL", external_url: "External URL", matchplay_url: "Match Play URL" };
    return special[key] || String(key).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")
      .replace(/\b(id|url|uuid)\b/gi, function (word) { return word.toUpperCase(); })
      .replace(/^./, function (letter) { return letter.toUpperCase(); });
  }

  function valueText(value, key) {
    if (value === undefined || value === null || value === "") return "—";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.length ? value.map(function (item) { return valueText(item, key); }).join(", ") : "—";
    if (typeof value === "object") return JSON.stringify(value, null, 2);
    if (typeof value === "string" && /(?:^|_)(?:date|at)$/.test(key || "") && /^\d{4}-\d\d-\d\d(?:$|T)/.test(value)) {
      var date = new Date(value.length === 10 ? value + "T12:00:00" : value);
      if (!Number.isNaN(date.getTime())) return value.length === 10
        ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : date.toLocaleString("en-US", { timeZone: "America/New_York" });
    }
    return String(value);
  }

  function changes(entry) {
    var before = object(entry.old_data), after = object(entry.new_data);
    var action = String(entry.action || "").toLowerCase();
    var mode = action === "create" || action === "grant" ? "after" :
      action === "delete" || action === "revoke" ? "before" : "compare";
    var keys = Array.from(new Set(Object.keys(before).concat(Object.keys(after))));
    if (mode === "compare") keys = keys.filter(function (key) {
      return !Object.prototype.hasOwnProperty.call(before, key) ||
        !Object.prototype.hasOwnProperty.call(after, key) || !same(before[key], after[key]);
    });
    return { mode: mode, fields: keys.map(function (key) {
      return { key: key, before: before[key], after: after[key] };
    }) };
  }

  function addCell(row, value) {
    var cell = document.createElement("td");
    cell.textContent = value == null ? "" : String(value);
    row.appendChild(cell);
    return cell;
  }

  function addValue(parent, value, key) {
    var text = valueText(value, key);
    var span = document.createElement("span");
    span.className = "member-audit-value";
    if (text.length > 300) {
      var short = document.createElement("span");
      short.textContent = text.slice(0, 300) + "…";
      var full = document.createElement("span");
      full.textContent = text;
      full.hidden = true;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "member-audit-more";
      button.textContent = "Show more";
      button.addEventListener("click", function () {
        full.hidden = !full.hidden;
        short.hidden = !full.hidden;
        button.textContent = full.hidden ? "Show more" : "Show less";
      });
      span.append(short, full, button);
    } else span.textContent = text;
    parent.appendChild(span);
  }

  function renderDetails(cell, entry) {
    var change = changes(entry);
    var fields = change.fields;
    if (fields.length) {
      var grid = document.createElement("div");
      grid.className = "member-audit-changes" + (change.mode === "compare" ? " is-comparison" : "");
      fields.forEach(function (field) {
        var item = document.createElement("div");
        item.className = "member-audit-change";
        var name = document.createElement("strong");
        name.className = "member-audit-field";
        name.textContent = label(field.key);
        item.appendChild(name);
        if (change.mode === "compare") {
          ["before", "after"].forEach(function (side) {
            var part = document.createElement("div");
            part.className = "member-audit-side";
            var heading = document.createElement("span");
            heading.className = "member-audit-side-label";
            heading.textContent = side === "before" ? "Before" : "After";
            part.appendChild(heading);
            addValue(part, field[side], field.key);
            item.appendChild(part);
          });
        } else addValue(item, field[change.mode], field.key);
        grid.appendChild(item);
      });
      cell.appendChild(grid);
    } else {
      var note = document.createElement("p");
      note.className = "member-form-hint";
      var listed = object(entry.metadata).changed_fields;
      note.textContent = Array.isArray(listed) && listed.length
        ? "Changed fields: " + listed.map(label).join(", ") + ". Values are not stored for this record."
        : "No field values were recorded for this change.";
      cell.appendChild(note);
    }
    var raw = document.createElement("details");
    raw.className = "member-audit-raw";
    var summary = document.createElement("summary");
    summary.textContent = "Raw data";
    var pre = document.createElement("pre");
    pre.className = "member-audit-details";
    try {
      pre.textContent = JSON.stringify({ before: entry.old_data, after: entry.new_data, context: entry.metadata }, null, 2) || "{}";
    } catch (_) { pre.textContent = "Raw data could not be displayed."; }
    raw.append(summary, pre);
    cell.appendChild(raw);
  }

  function showRow(entry) {
    var row = document.createElement("tr");
    row.className = "member-audit-row";
    row.tabIndex = 0;
    var date = new Date(entry.created_at);
    addCell(row, Number.isNaN(date.getTime()) ? "Unknown" :
      date.toLocaleString("en-US", { timeZone: "America/New_York" }));
    addCell(row, entry.actor_label || "System");
    addCell(row, entry.module || "");
    addCell(row, entry.action || "");
    var recordCell = addCell(row, entry.entity_type || "");
    if (entry.entity_id) {
      var id = String(entry.entity_id);
      var copy = document.createElement("button");
      copy.type = "button";
      copy.className = "member-audit-id";
      copy.textContent = " · " + (id.length > 12 ? id.slice(0, 8) + "…" : id);
      copy.title = id;
      copy.setAttribute("aria-label", "Copy record ID " + id);
      copy.addEventListener("click", function (event) {
        event.stopPropagation();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(id).then(function () { copy.title = "Copied: " + id; }, function () { copy.textContent = " · " + id; });
        } else copy.textContent = " · " + id;
      });
      recordCell.appendChild(copy);
    }
    var controlCell = document.createElement("td");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "member-audit-toggle";
    button.textContent = "View ▾";
    var detailsId = "member-audit-detail-" + (++nextDetailId);
    button.setAttribute("aria-controls", detailsId);
    button.setAttribute("aria-expanded", "false");
    controlCell.appendChild(button);
    row.appendChild(controlCell);
    tableBody.appendChild(row);
    var detailRow = document.createElement("tr");
    detailRow.id = detailsId;
    detailRow.className = "member-audit-detail-row";
    detailRow.hidden = true;
    var detailCell = document.createElement("td");
    detailCell.colSpan = 6;
    renderDetails(detailCell, entry);
    detailRow.appendChild(detailCell);
    tableBody.appendChild(detailRow);
    function toggle() {
      detailRow.hidden = !detailRow.hidden;
      var open = !detailRow.hidden;
      button.setAttribute("aria-expanded", String(open));
      button.textContent = open ? "Hide ▴" : "View ▾";
      row.classList.toggle("is-expanded", open);
    }
    button.addEventListener("click", function (event) { event.stopPropagation(); toggle(); });
    row.addEventListener("click", function (event) {
      if (!event.target.closest("button, a, input, select, textarea, summary")) toggle();
    });
    row.addEventListener("keydown", function (event) {
      if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      toggle();
    });
  }

  async function load(older) {
    if (!allowed || !initialized || loading || !window.SNHMemberPortal) return;
    loading = true;
    status.textContent = "Loading change history…";
    moduleSelect.disabled = true;
    if (olderButton) olderButton.disabled = true;
    try {
      var rows = await window.SNHMemberPortal.listAuditHistoryForAdmin({
        module: moduleSelect.value,
        beforeCreatedAt: older && cursor ? cursor.created_at : null,
        beforeId: older && cursor ? cursor.id : null
      });
      if (!older) tableBody.replaceChildren();
      rows.forEach(function (entry) { try { showRow(entry || {}); } catch (_) { /* Keep other records visible. */ } });
      if (rows.length) cursor = rows[rows.length - 1];
      else if (!older) cursor = null;
      olderButton.hidden = rows.length < pageSize;
      status.textContent = tableBody.children.length
        ? "Showing " + (tableBody.children.length / 2) + " recent change(s)."
        : "No changes recorded yet.";
    } catch (error) {
      status.textContent = "Could not load change history: " +
        (error && error.message ? error.message : "Please try again.");
    } finally {
      loading = false;
      moduleSelect.disabled = false;
      olderButton.disabled = false;
    }
  }

  function init(roles) {
    if (initialized) return;
    initialized = true;
    allowed = Array.isArray(roles) && roles.indexOf("club_admin") !== -1;
    section = document.getElementById("member-audit-section");
    if (!section || !allowed) return;
    section.hidden = false;
    tableBody = document.getElementById("member-audit-table-body");
    status = document.getElementById("member-audit-status");
    moduleSelect = document.getElementById("member-audit-module");
    olderButton = document.getElementById("member-audit-older");
    document.getElementById("member-audit-refresh").addEventListener("click", function () { void load(false); });
    moduleSelect.addEventListener("change", function () { void load(false); });
    olderButton.addEventListener("click", function () { void load(true); });
  }

  window.SNHMemberAuditPanel = { init: init, load: load, changes: changes, valueText: valueText, label: label };
})();
