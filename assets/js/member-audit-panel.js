(function () {
  var section;
  var tableBody;
  var status;
  var moduleSelect;
  var olderButton;
  var cursor = null;
  var initialized = false;
  var allowed = false;
  var loading = false;
  var pageSize = 50;

  function addCell(row, value) {
    var cell = document.createElement("td");
    cell.textContent = value == null ? "" : String(value);
    row.appendChild(cell);
    return cell;
  }

  function showRow(entry) {
    var row = document.createElement("tr");
    var date = new Date(entry.created_at);
    addCell(row, Number.isNaN(date.getTime()) ? "Unknown" :
      date.toLocaleString("en-US", { timeZone: "America/New_York" }));
    addCell(row, entry.actor_label || "System");
    addCell(row, entry.module || "");
    addCell(row, entry.action || "");
    var recordCell = addCell(row, entry.entity_type || "");
    if (entry.entity_id) {
      recordCell.textContent += " · " + String(entry.entity_id);
    }

    var detailsCell = document.createElement("td");
    var details = document.createElement("details");
    var summary = document.createElement("summary");
    summary.textContent = "View";
    var pre = document.createElement("pre");
    pre.className = "member-audit-details";
    pre.textContent = JSON.stringify({
      before: entry.old_data || {},
      after: entry.new_data || {},
      context: entry.metadata || {}
    }, null, 2);
    details.appendChild(summary);
    details.appendChild(pre);
    detailsCell.appendChild(details);
    row.appendChild(detailsCell);
    tableBody.appendChild(row);
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
      rows.forEach(showRow);
      if (rows.length) cursor = rows[rows.length - 1];
      else if (!older) cursor = null;
      olderButton.hidden = rows.length < pageSize;
      status.textContent = tableBody.children.length
        ? "Showing " + tableBody.children.length + " recent change(s)."
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

  window.SNHMemberAuditPanel = { init: init, load: load };
})();
