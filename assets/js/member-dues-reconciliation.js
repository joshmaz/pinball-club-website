(function () {
  "use strict";

  const headers = ["date", "time", "name", "type", "from email address"];
  const paymentType = "subscription payment";
  const unlinked = "unlinked";

  function parse(text) {
    if (text.length > 500000) throw new Error("Paste at most 500 KB at a time.");
    const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    const columns = lines.shift().split("\t").map(value => value.trim().toLowerCase());
    const indexes = headers.map(header => columns.indexOf(header));
    if (indexes.includes(-1)) throw new Error("Copy the five column headers and payment rows from the spreadsheet.");
    if (lines.length > 10000) throw new Error("Paste at most 10,000 rows at a time.");

    const groups = new Map();
    let skipped = 0;
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const values = line.split("\t");
      if (values.length !== columns.length) throw new Error("Check the columns on row " + (index + 2) + ".");
      const [date, time, name, type, rawEmail] = indexes.map(i => values[i].trim());
      if (type.toLowerCase() !== paymentType) {
        skipped++;
        return;
      }
      const email = rawEmail.toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254) {
        throw new Error("Check the payer email on row " + (index + 2) + ".");
      }
      const dateParts = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
      const timeParts = /^(\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?$/i.exec(time);
      if (!dateParts || !timeParts) throw new Error("Check the date and time on row " + (index + 2) + ".");
      const [, month, day, year] = dateParts;
      const isoDate = [year, month.padStart(2, "0"), day.padStart(2, "0")].join("-");
      const parsedDate = new Date(isoDate + "T00:00:00Z");
      let hour = Number(timeParts[1]);
      const [, , minute, second, meridiem] = timeParts;
      if (!Number.isFinite(+parsedDate) || parsedDate.toISOString().slice(0, 10) !== isoDate
          || +minute > 59 || +second > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) {
        throw new Error("Check the date and time on row " + (index + 2) + ".");
      }
      if (meridiem) hour = hour % 12 + (meridiem.toUpperCase() === "PM" ? 12 : 0);
      const received = isoDate + "T" + [String(hour).padStart(2, "0"), minute, second].join(":");
      if (!groups.has(email)) groups.set(email, { email, name, dates: new Set(), duplicates: 0 });
      const group = groups.get(email);
      if (group.dates.has(received)) group.duplicates++;
      group.dates.add(received);
    });
    return { groups, skipped };
  }

  function formatPayerName(name) {
    if (name !== name.toLowerCase()) return name;
    return name.replace(/(^|[\s\p{Pd}'’])(\p{Ll})/gu, (_, prefix, letter) => prefix + letter.toUpperCase());
  }

  function element(parent, tag, value) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    parent.append(node);
    return node;
  }

  function field(parent, title, tag, type) {
    const label = element(parent, "label", title + " ");
    if (type !== "checkbox") label.className = "member-dues-field";
    const input = element(label, tag);
    if (type) input.type = type;
    return input;
  }

  function action(parent, title, handler, feedback) {
    const button = element(parent, "button", title);
    button.type = "button";
    button.className = "members-sidebar-link";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await handler();
      } catch (error) {
        feedback.textContent = error.message || "The change could not be saved.";
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  async function request(actionName, args = {}) {
    const { data, error } = await window.snhSupabase.rpc("snh_reconcile_dues", {
      p_action: actionName, ...args
    });
    if (error?.code === "PGRST202") {
      throw new Error("Dues reconciliation is unavailable until its database migration is applied to this environment.");
    }
    if (error) throw new Error(error.message);
    return data;
  }

  function overdue(payer) {
    if (!payer.member_id || !payer.review_enabled || !payer.last_received || !payer.coverage_through) return false;
    const last = new Date(payer.last_received + "T00:00:00Z");
    const day = last.getUTCDate();
    last.setUTCDate(1);
    last.setUTCMonth(last.getUTCMonth() + 1);
    const endOfMonth = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)).getUTCDate();
    last.setUTCDate(Math.min(day, endOfMonth) + 7);
    return payer.coverage_through >= last.toISOString().slice(0, 10);
  }

  function renderPayer(parent, group, state, payer, reload) {
    const saved = new Set(state.receipts[group.email] || []);
    const dates = [...group.dates].sort().filter(date => !saved.has(date));
    const section = element(parent, "details");
    const matches = state.members.filter(member =>
      member.verifiedEmail === group.email || state.paymentEmails[member.id] === group.email
    );
    const pending = state.holds[group.email];
    const status = dates.length ? dates.length + " to review"
      : pending ? "On hold" : payer?.roster_name ? "Unlinked payments" : saved.size ? "Recorded" : "Follow-up";
    element(section, "summary", [group.name, group.email, status].filter(Boolean).join(" · "));
    const history = [...saved].sort();
    if (history.length) element(section, "p", "Recorded payments: " + history.map(date => date.slice(0, 10)).join(", "));
    if (group.duplicates) element(section, "p", group.duplicates + " repeated timestamp rows grouped as duplicates. Check these against PayPal.");
    if (matches.length === 1 && !payer?.member_id) {
      const source = matches[0].verifiedEmail === group.email ? "verified website email" : "member-provided PayPal email";
      element(section, "p", "Suggested by " + source + ": " + matches[0].name);
    }
    if (matches.length > 1 && !payer?.member_id) {
      element(section, "p", "Multiple members match this email. Verify the correct member before linking.");
    }
    if (overdue(payer || {})) element(section, "p", "Payment overdue for review.");
    const feedback = element(section, "p");
    feedback.setAttribute("role", "status");

    function memberPicker(container, label, allowUnlinked) {
      const select = field(container, label, "select");
      element(select, "option", "Choose a member").value = "";
      if (allowUnlinked) {
        element(select, "option", "Save payments without linking a member").value = unlinked;
      }
      for (const entry of state.members) {
        element(select, "option", entry.name + (entry.verifiedEmail ? " (" + entry.verifiedEmail + ")" : "")).value = entry.id;
      }
      select.value = payer?.member_id || (matches.length === 1 && matches[0].verifiedEmail === group.email ? matches[0].id : "");
      return select;
    }

    if (dates.length) {
      const member = memberPicker(section, "Member for this payer", !payer?.member_id);
      if (!member.value && payer?.roster_name) member.value = unlinked;
      member.disabled = Boolean(payer?.member_id);
      element(section, "p", "Select which new payments to record. Choosing a member links this payer’s full saved history.");
      const unlinkedFields = element(section, "div");
      const name = field(unlinkedFields, "Member name to help identify these payments later", "input", "text");
      name.maxLength = 150;
      name.value = payer?.roster_name || formatPayerName(group.name || "");
      name.readOnly = Boolean(payer?.roster_name);
      element(unlinkedFields, "p", "Payments are saved for later linking. No website account or invitation is created.");
      const updateUnlinkedFields = () => { unlinkedFields.hidden = member.value !== unlinked; };
      member.addEventListener("change", updateUnlinkedFields);
      updateUnlinkedFields();
      const list = element(section, "ul");
      const choices = dates.map(date => [date, field(element(list, "li"), date.replace("T", " "), "input", "checkbox")]);
      action(section, "Select all payments for this payer", () => {
        for (const [, input] of choices) input.checked = true;
      }, feedback);
      action(section, "Apply selected payments", async () => {
        const selected = choices.filter(([, input]) => input.checked).map(([date]) => date);
        if (!selected.length) throw new Error("Select the payments to apply.");
        if (!member.value) throw new Error("Choose a website member or select Save payments without linking a member.");
        if (member.value === unlinked && !name.value.trim()) throw new Error("Enter the member’s name so you can identify the payments later.");
        await request("apply", {
          p_email: group.email, p_dates: selected,
          p_member: member.value === unlinked ? null : member.value,
          p_name: member.value === unlinked ? name.value.trim() : null
        });
        await reload("Selected payments recorded.", member.value === unlinked ? group.email : undefined);
      }, feedback);
    }

    if (payer) {
      if (payer.roster_name) element(section, "p", "Unlinked payments for " + payer.roster_name + ".");
      if (payer.last_received) element(section, "p", "Last confirmed payment: " + payer.last_received);
      const linking = element(section, "details");
      element(linking, "summary", payer.member_id ? "Correct member link" : "Link payments to a member");
      const target = memberPicker(linking, "Member for all saved payments", false);
      action(linking, "Save member link", async () => {
        if (!target.value) throw new Error("Choose the correct website member.");
        if (target.value === payer.member_id) throw new Error("Choose a different website member.");
        if (!window.confirm("Move this payer’s entire recorded history to the selected member?")) return;
        await request("relink", { p_email: group.email, p_member: target.value });
        await reload("Member link saved.");
      }, feedback);
    }

    if (dates.length || pending) {
      if (pending && !dates.length) {
        element(section, "p", "To resume this review, paste the original spreadsheet rows with their headers and click Preview payments. Then select the payments to record and click Apply selected payments.");
      }
      const note = field(section, "Review note", "input", "text");
      note.maxLength = 500;
      note.value = pending || "";
      action(section, "Save review note", async () => {
        await request("hold", { p_email: group.email, p_note: note.value });
        feedback.textContent = "Review note saved for this payer. To resume after leaving this page, preview the original rows again.";
      }, feedback);
    }

    if (payer?.member_id) {
      const enabled = field(section, "Monitor monthly renewal", "input", "checkbox");
      enabled.checked = payer.review_enabled;
      const coverage = field(section, "Payments checked through", "input", "date");
      coverage.value = payer.coverage_through || "";
      action(section, "Save renewal review settings", async () => {
        await request("review_setting", {
          p_email: group.email, p_review_enabled: enabled.checked, p_coverage: coverage.value || null
        });
        await reload("Renewal review settings saved.");
      }, feedback);
    }
  }

  const panel = document.getElementById("member-dues-reconciliation");
  if (!panel) return;

  const input = panel.querySelector("textarea");
  const status = panel.querySelector("[data-dues-status]");
  const results = panel.querySelector("[data-dues-results]");
  const preview = panel.querySelector("[data-dues-preview]");
  let groups = new Map();
  let generation = 0;
  let authorized = false;
  let loaded = false;
  const directoryTab = document.getElementById("member-directory-tab");
  const duesTab = document.getElementById("member-dues-tab");
  const directory = document.getElementById("member-directory-panel");
  const tabs = directoryTab.parentElement;

  function selectTab(tab) {
    const showDues = authorized && tab === duesTab;
    for (const button of [directoryTab, duesTab]) {
      const selected = button === (showDues ? duesTab : directoryTab);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    directory.hidden = showDues;
    panel.hidden = !showDues;
    if (showDues && !loaded) render().catch(error => {
      if (authorized && !panel.hidden) status.textContent = error.message;
    });
  }

  for (const tab of [directoryTab, duesTab]) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" || (event.key !== "End" && tab === duesTab) ? directoryTab : duesTab;
      selectTab(next);
      next.focus();
    });
  }

  async function render(message, savedUnlinkedEmail) {
    const current = ++generation;
    const open = new Set([...results.querySelectorAll("details[data-payer][open]")].map(section => section.dataset.payer));
    const [state, paymentEmails] = await Promise.all([
      request("load"),
      window.snhSupabase.rpc("snh_dues_payment_email_suggestions")
    ]);
    state.paymentEmails = paymentEmails.data || {};
    if (current !== generation || !authorized) return;
    loaded = true;
    state.members.sort((a, b) => a.name.localeCompare(b.name));
    const payers = new Map(state.payers.map(payer => [payer.email, payer]));
    const visible = new Map(groups);
    for (const email of [...payers.keys(), ...Object.keys(state.holds)]) {
      const payer = payers.get(email);
      if (!visible.has(email)) visible.set(email, { email, name: payer?.roster_name, dates: [] });
    }
    results.replaceChildren();
    const unlinkedGroups = [];
    function showPayer(container, group, payer, isUnlinked = false) {
      renderPayer(container, group, state, payer, render);
      const details = container.lastElementChild;
      details.dataset.payer = group.email;
      if (isUnlinked) details.setAttribute("name", "dues-saved-unlinked-payers");
      details.open = isUnlinked && savedUnlinkedEmail
        ? group.email === savedUnlinkedEmail
        : open.has(group.email);
    }

    for (const group of visible.values()) {
      const payer = payers.get(group.email);
      if (payer && !payer.member_id) unlinkedGroups.push(group);
      else showPayer(results, group, payer);
    }

    if (unlinkedGroups.length) {
      const section = element(results, "section");
      element(section, "h3", "Saved payments awaiting a member link");
      element(section, "p", "These payments are already recorded. When the person has a website account, expand their entry and choose Link payments to a member to attach their saved payment history.");
      for (const group of unlinkedGroups) showPayer(section, group, payers.get(group.email), true);
    }
    status.textContent = message || (visible.size ? "" : "No saved reconciliation records.");
  }

  function clear() {
    generation++;
    groups = new Map();
    input.value = "";
    results.replaceChildren();
    status.textContent = "";
  }

  preview.addEventListener("click", async () => {
    preview.disabled = true;
    try {
      const parsed = parse(input.value);
      groups = parsed.groups;
      await render(groups.size + " payer groups. " + parsed.skipped + " non-subscription rows skipped.");
      input.value = "";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      preview.disabled = false;
    }
  });
  panel.querySelector("[data-dues-clear]").addEventListener("click", () => {
    clear();
    render("Pasted data cleared.").catch(error => { status.textContent = error.message; });
  });
  window.SNHDuesReconciliation = {
    setRoles(roles) {
      authorized = roles.some(role => ["membership_admin", "club_admin"].includes(role));
      tabs.hidden = !authorized;
      if (authorized) {
        directory.setAttribute("role", "tabpanel");
        directory.setAttribute("aria-labelledby", directoryTab.id);
        directory.tabIndex = 0;
      } else {
        directory.removeAttribute("role");
        directory.removeAttribute("aria-labelledby");
        directory.removeAttribute("tabindex");
        selectTab(directoryTab);
        loaded = false;
        clear();
      }
    }
  };
})();
