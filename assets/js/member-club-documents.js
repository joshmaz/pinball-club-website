(function () {
  "use strict";

  async function rpc(name, args) {
    var result = await window.snhSupabase.rpc(name, args);
    if (result.error) throw result.error;
    return result.data;
  }

  function element(tag, text) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function button(text, action) {
    var node = element("button", text);
    node.type = "button";
    node.className = "club-button";
    node.addEventListener("click", action);
    return node;
  }

  function renderDesignation(container, row, roles, onSaved) {
    var designation = row.club_designation || "";
    var title = row.club_title || "";
    container.appendChild(element("h4", "Club designation"));
    if (!roles.includes("membership_admin") && !roles.includes("club_admin")) {
      container.appendChild(element("p", title || ({ board: "Board", staff: "Staff" })[designation] || "None"));
      return;
    }
    if (!designation && !row.email_verified) {
      container.appendChild(element("p", "This member must verify their email before receiving a club designation."));
      return;
    }

    var form = element("form");
    form.className = "members-admin-editor-form";
    var designationLabel = element("label", "Designation ");
    var select = element("select");
    [["", "None"], ["board", "Board"], ["staff", "Staff"]].forEach(function (choice) {
      var option = element("option", choice[1]);
      option.value = choice[0];
      option.disabled = !!choice[0] && !row.email_verified;
      select.appendChild(option);
    });
    select.value = designation;
    designationLabel.appendChild(select);

    var titleLabel = element("label", "Display title ");
    var input = element("input");
    input.maxLength = 80;
    input.value = title;
    titleLabel.appendChild(input);
    var save = element("button", "Save designation");
    save.type = "submit";
    var feedback = element("span");
    feedback.setAttribute("role", "status");

    function update() {
      input.disabled = !select.value;
      save.disabled = select.value === designation && (!select.value || input.value.trim() === title);
    }

    select.addEventListener("change", update);
    input.addEventListener("input", update);
    update();
    form.append(designationLabel, titleLabel, save, feedback);
    container.appendChild(form);

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (save.disabled) return;
      save.disabled = select.disabled = input.disabled = true;
      feedback.textContent = "Saving…";
      try {
        await rpc("snh_set_club_designation", {
          p_member_id: row.member_id,
          p_designation: select.value || null,
          p_title: input.value.trim() || null
        });
        row.club_designation = designation = select.value || null;
        row.club_title = title = designation ? input.value.trim() : "";
        feedback.textContent = "Saved.";
        await onSaved();
      } catch (error) {
        feedback.textContent = error.message || "Could not save designation.";
      } finally {
        select.disabled = false;
        update();
      }
    });
  }

  var editingId = null;
  var initialized = false;
  var pending = false;
  var loadRequest = 0;
  var dom;

  function setEditor(link) {
    editingId = link ? link.id : null;
    dom.form.reset();
    dom.linkStatus.textContent = "";
    dom.formTitle.textContent = link ? "Edit document link" : "Add document link";
    if (link) {
      dom.title.value = link.title;
      dom.url.value = link.url;
      dom.date.value = link.meeting_date || "";
      dom.pinned.checked = link.pinned;
    }
    dom.form.hidden = false;
    dom.title.focus();
  }

  async function saveChange(name, args, message, invalidMessage) {
    if (pending) return;
    var status = name === "snh_save_club_document" ? dom.linkStatus : dom.status;
    pending = true;
    dom.form.querySelector("fieldset").disabled = dom.folderSave.disabled = true;
    status.textContent = "Saving…";
    try {
      await rpc(name, args);
      dom.form.hidden = true;
      await load(message);
    } catch (error) {
      status.textContent = error.code === "23514"
        ? (invalidMessage || "Enter a direct Google Drive file link. Open the file and choose Share → Copy link.")
        : error.message || "Could not save the change.";
    } finally {
      pending = false;
      dom.form.querySelector("fieldset").disabled = dom.folderSave.disabled = false;
    }
  }

  function mount() {
    if (initialized) return;
    var byId = document.getElementById.bind(document);
    dom = {
      status: byId("club-documents-status"),
      tools: byId("club-documents-tools"),
      folder: byId("club-documents-folder"),
      folderSettings: byId("club-documents-folder-settings"),
      folderForm: byId("club-documents-folder-form"),
      folderInput: byId("club-documents-folder-url"),
      folderSave: byId("club-documents-folder-form").querySelector("button"),
      add: byId("club-documents-add"),
      actions: byId("club-documents-actions"),
      manage: byId("club-documents-manage"),
      list: byId("club-documents-list"),
      form: byId("club-documents-form"),
      formTitle: byId("club-documents-form-title"),
      title: byId("club-document-title"),
      url: byId("club-document-url"),
      date: byId("club-document-date"),
      pinned: byId("club-document-pinned"),
      rosterStatus: byId("board-staff-status"),
      roster: byId("board-staff-roster")
    };
    dom.add.addEventListener("click", function () { if (!pending) setEditor(null); });
    dom.manage.addEventListener("click", function () {
      if (pending) return;
      var managing = dom.manage.getAttribute("aria-pressed") !== "true";
      dom.manage.setAttribute("aria-pressed", String(managing));
      dom.list.querySelectorAll(".club-document-link-actions").forEach(function (controls) {
        controls.hidden = !managing;
      });
      if (!managing && editingId) dom.form.hidden = true;
    });
    dom.linkStatus = element("p");
    dom.linkStatus.className = "members-page-status";
    dom.linkStatus.setAttribute("role", "status");
    dom.form.querySelector("fieldset").appendChild(dom.linkStatus);
    byId("club-documents-cancel").addEventListener("click", function () {
      dom.form.hidden = true;
      dom.add.focus();
    });
    dom.form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (pending) return;
      var url = dom.url.value.trim();
      if (/^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\//i.test(url)) {
        dom.linkStatus.textContent = "This is a folder link. Open the file inside Drive, then choose Share → Copy link.";
        return;
      }
      void saveChange("snh_save_club_document", {
        p_id: editingId,
        p_title: dom.title.value.trim(),
        p_url: url,
        p_meeting_date: dom.date.value || null,
        p_pinned: dom.pinned.checked
      }, "Link saved.");
    });
    dom.folderForm.addEventListener("submit", function (event) {
      event.preventDefault();
      void saveChange("snh_set_club_document_folder", { p_url: dom.folderInput.value.trim() },
        "Board folder shortcut updated.", "Enter a Google Drive folder link.");
    });
    initialized = true;
  }

  function renderLinks(data) {
    var canEdit = data.can_edit;
    dom.tools.hidden = dom.folderSettings.hidden = !canEdit;
    dom.actions.hidden = !canEdit;
    dom.manage.hidden = data.links.length === 0;
    dom.folder.hidden = !data.board_folder_url;
    dom.folderInput.value = data.board_folder_url || "";
    if (data.board_folder_url) dom.folder.href = data.board_folder_url;
    else dom.folder.removeAttribute("href");
    dom.form.hidden = true;
    dom.list.replaceChildren();
    data.links.forEach(function (link) {
      var row = element("li");
      var anchor = element("a", link.title);
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      row.append(anchor);
      if (link.pinned) row.append(" · Pinned");
      if (link.meeting_date) row.append(" · " + new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium", timeZone: "UTC"
      }).format(new Date(link.meeting_date + "T00:00:00Z")));
      if (canEdit) {
        var controls = element("div");
        controls.className = "members-admin-controls";
        var edit = button("Edit link", function () { if (!pending) setEditor(link); });
        edit.setAttribute("aria-label", "Edit link for " + link.title);
        var remove = button("Remove link", function () {
          if (!pending && window.confirm("Remove the portal link for “" + link.title + "”?")) {
            void saveChange("snh_remove_club_document", { p_id: link.id }, "Link removed.");
          }
        });
        remove.setAttribute("aria-label", "Remove link for " + link.title);
        controls.append(edit, remove);
        var actions = element("div");
        actions.className = "club-document-link-actions";
        actions.hidden = dom.manage.getAttribute("aria-pressed") !== "true";
        actions.appendChild(controls);
        row.appendChild(actions);
      }
      dom.list.appendChild(row);
    });
  }

  function renderRoster(roster) {
    dom.roster.replaceChildren();
    [["board", "Board", "Director"], ["staff", "Staff", "Club Staff"]].forEach(function (group) {
      var people = roster.filter(function (person) { return person.designation === group[0]; });
      if (!people.length) return;
      var list = element("ul");
      people.forEach(function (person) {
        list.appendChild(element("li", person.name + " · " + (person.title || group[2])));
      });
      dom.roster.append(element("h4", group[1]), list);
    });
  }

  async function load(message) {
    mount();
    var request = ++loadRequest;
    dom.status.textContent = "Loading…";
    dom.rosterStatus.textContent = "";
    dom.tools.hidden = dom.folderSettings.hidden = dom.form.hidden = true;
    dom.actions.hidden = true;
    if (!message) dom.manage.setAttribute("aria-pressed", "false");
    dom.list.replaceChildren();
    dom.roster.replaceChildren();
    try {
      var data = await rpc("snh_club_documents");
      if (request !== loadRequest) return;
      renderLinks(data);
      renderRoster(data.roster);
      dom.status.textContent = message || (data.links.length ? "" : "No document links have been added yet.");
      dom.rosterStatus.textContent = data.roster.length ? "" : "No board or staff members have been listed yet.";
    } catch (error) {
      if (request === loadRequest) dom.status.textContent = "Could not load the roster or club documents.";
    }
  }

  window.SNHMemberClubDocuments = { load: load, renderDesignation: renderDesignation };
})();
