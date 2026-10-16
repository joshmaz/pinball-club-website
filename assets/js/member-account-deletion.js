(function () {
  "use strict";
  function element(tag, text, parent) {
    var el = document.createElement(tag);
    if (text) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }
  async function request(body) {
    var cfg = window.SNH_CONFIG || {};
    var base = cfg.functionsBaseUrl || String(cfg.supabaseUrl || "").replace(/\/+$/, "") + "/functions/v1";
    var session = body.action === "status" ? null : await window.SNHSiteAuth.getSession();
    var headers = { "Content-Type": "application/json" };
    if (session && session.access_token) headers.Authorization = "Bearer " + session.access_token;
    if (cfg.supabaseAnonKey) headers.apikey = cfg.supabaseAnonKey;
    var response = await fetch(base + "/account-delete", {
      method: "POST", headers: headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
    });
    var result = await response.json();
    if (!response.ok) {
      var error = new Error(result.error || "Could not confirm deletion."); error.status = response.status; throw error;
    }
    return result;
  }
  function mount(parent, options) {
    var self = !options.memberId;
    var key = "snh-account-deletion:" + (options.memberId || options.actorId);
    var details = element("details", "", parent); details.className = "account-deletion";
    element("summary", self ? "Delete my account" : "Delete account", details);
    var target = element("p", self ? "Permanently delete your website account?" : "Permanently delete the website account for ", details);
    if (!self) {
      element("strong", options.name, target);
      element("span", " (", target);
      element("strong", options.email, target);
      element("span", ")?", target);
    }
    element("p", "The profile, membership record, website roles, linked accounts, and attendance records will be removed. Website access and door-code retrieval end immediately. The shared door code itself does not change. This cannot be undone.", details);
    element("p", "Club photos, events, scores, and notes remain, with account attribution removed. Limited audit history remains. For help removing personal information within club content, email support@snhpinballclub.com.", details);
    element("p", "Deleting a website account does not cancel PayPal payments. If leaving the club, cancel the recurring subscription separately in PayPal. A recorded Basic or inactive membership does not prove payments have stopped.", details);
    if (self && options.websiteAdmin) {
      element("p", "Another Website Administrator must delete your account. The club must retain at least one Website Administrator.", details);
      return;
    }
    var status = element("p", "", details); status.setAttribute("role", "status");
    var form = element("form", "", details); form.className = "members-profile-form";
    function input(label, type) {
      var wrap = element("label", label + " ", form);
      var el = element("input", "", wrap); el.type = type; el.required = true;
      return el;
    }
    var reason;
    if (!self) { reason = input("Reason (avoid personal or payment details)", "text"); reason.maxLength = 250; }
    var password = input("Your current password", "password"); password.autocomplete = "current-password";
    var acknowledgment = input("I understand recurring PayPal payments must be canceled separately if this member is leaving the club.", "checkbox");
    var confirmation = input("Type DELETE to confirm permanent deletion", "text"); confirmation.pattern = "DELETE"; confirmation.autocomplete = "off";
    var submit = element("button", self ? "Permanently delete my account" : "Permanently delete this account", form); submit.type = "submit";
    var check = element("button", "Check deletion status", details); check.type = "button"; check.hidden = true;
    var receipt = null;
    try { receipt = sessionStorage.getItem(key); } catch (_e) { /* storage is optional */ }
    function saveReceipt(value) {
      receipt = value;
      try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch (_e) { /* optional */ }
      check.hidden = !value;
    }
    async function completed() {
      saveReceipt(null); form.hidden = true; check.hidden = true;
      status.textContent = "Account deleted. Recurring PayPal payments are not canceled by website deletion.";
      if (self) {
        try { await window.SNHSiteAuth.signOut(); } catch (_e) { /* Deleted account has no refresh session. */ }
        window.location.assign("signin.html?account=deleted");
      } else if (options.onDeleted) await options.onDeleted();
    }
    async function checkStatus() {
      if (!receipt) return;
      check.disabled = true;
      try {
        var result = await request({ action: "status", receipt: receipt });
        if (result.completed) { await completed(); return; }
        status.textContent = "Deletion has not completed. You may retry with fresh confirmation. If a request is still running, wait five minutes or contact support@snhpinballclub.com.";
        form.hidden = false;
      } catch (error) {
        status.textContent = error.status === 404 ? "The status receipt has expired. Check the member directory or contact support@snhpinballclub.com before starting again." : "Status could not be confirmed. Keep this page and check again, or contact support@snhpinballclub.com.";
      } finally { check.disabled = false; }
    }
    if (receipt) {
      details.open = true; check.hidden = false; form.hidden = true;
      status.textContent = "A previous deletion request needs its status checked.";
    }
    check.addEventListener("click", checkStatus);
    form.addEventListener("submit", async function (event) {
      event.preventDefault(); if (submit.disabled || !form.reportValidity()) return;
      submit.disabled = true;
      status.textContent = "Verifying your password and account permissions…";
      try {
        var prepared = await request({ action: "prepare", memberId: options.memberId || null,
          password: password.value, reason: reason ? reason.value : undefined,
          confirmation: confirmation.value, billingAcknowledged: acknowledgment.checked });
        saveReceipt(prepared.receipt);
        password.value = "";
        status.textContent = "Deleting account…";
        var result = await request({ action: "delete", receipt: receipt });
        if (result.completed) await completed();
      } catch (error) {
        status.textContent = receipt ? "Could not confirm completion. Check deletion status before retrying." : error.message;
        if (receipt) form.hidden = true;
      } finally { password.value = ""; submit.disabled = false; }
    });
  }
  function recoverPending(parent) {
    var keys = [];
    try { for (var i = 0; i < sessionStorage.length; i++) {
      var key = sessionStorage.key(i); if (key.indexOf("snh-account-deletion:") === 0) keys.push(key);
    } } catch (_e) { return; }
    keys.slice(0, 20).forEach(function (key) {
      var receipt = sessionStorage.getItem(key);
      var section = element("section", "", parent);
      var status = element("p", "A previous account deletion needs its status checked.", section); status.setAttribute("role", "status");
      var button = element("button", "Check previous deletion status", section); button.type = "button";
      button.addEventListener("click", async function () {
        button.disabled = true;
        try {
          var result = await request({ action: "status", receipt: receipt });
          status.textContent = result.completed ? "Account deletion completed. Recurring PayPal payments were not canceled by website deletion." : "Deletion has not completed. Sign in to retry, or contact support@snhpinballclub.com.";
          if (result.completed) { sessionStorage.removeItem(key); button.hidden = true; }
        } catch (_e) { status.textContent = "Status could not be confirmed. Check the member directory or contact support@snhpinballclub.com."; }
        finally { button.disabled = false; }
      });
    });
  }
  window.SNHAccountDeletion = { mount: mount, recoverPending: recoverPending };
})();
