(function () {
  var accountRoot = null;
  var accountLink = document.querySelector("[data-site-account-link]");
  if (!accountLink || !window.SNHSiteAuth) return;

  var signinHref = accountLink.getAttribute("href") || "signin.html";
  var pathPrefix = signinHref.slice(0, Math.max(0, signinHref.length - "signin.html".length));
  var dashboardHref = pathPrefix + "members.html";
  var linkClass = accountLink.className;

  function createSignedOutLink() {
    var link = document.createElement("a");
    link.href = signinHref;
    link.className = linkClass;
    link.textContent = "Members";
    link.setAttribute("data-site-account-link", "");
    return link;
  }

  function closeMenu() {
    if (!accountRoot) return;
    var trigger = accountRoot.querySelector(".site-account-trigger");
    var menu = accountRoot.querySelector(".site-account-menu");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (menu) menu.hidden = true;
  }

  function createSignedInMenu() {
    var root = document.createElement("span");
    root.className = "site-account";

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "site-account-trigger";
    trigger.textContent = "My Account";
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-haspopup", "menu");

    var menu = document.createElement("span");
    menu.className = "site-account-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    var dashboard = document.createElement("a");
    dashboard.href = dashboardHref;
    dashboard.textContent = "Dashboard";
    dashboard.setAttribute("role", "menuitem");

    var signout = document.createElement("button");
    signout.type = "button";
    signout.className = "site-account-signout";
    signout.textContent = "Sign out";
    signout.setAttribute("role", "menuitem");

    var status = document.createElement("span");
    status.className = "visually-hidden";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    trigger.addEventListener("click", function () {
      var open = trigger.getAttribute("aria-expanded") === "true";
      trigger.setAttribute("aria-expanded", open ? "false" : "true");
      menu.hidden = open;
      if (!open) dashboard.focus();
    });

    signout.addEventListener("click", async function () {
      signout.disabled = true;
      signout.textContent = "Signing out…";
      status.textContent = "Signing out.";
      try {
        await window.SNHSiteAuth.signOut();
        render(null);
      } catch (error) {
        signout.disabled = false;
        signout.textContent = "Sign out";
        status.textContent = "Could not sign out. Please try again.";
        console.warn("[SNH] Sign out failed:", error);
      }
    });

    root.appendChild(trigger);
    menu.appendChild(dashboard);
    menu.appendChild(signout);
    root.appendChild(menu);
    root.appendChild(status);
    return root;
  }

  function render(session) {
    var signedIn = !!(session && session.user);
    if (signedIn && accountRoot) return;
    if (!signedIn && !accountRoot) return;

    if (signedIn) {
      accountRoot = createSignedInMenu();
      accountLink.replaceWith(accountRoot);
    } else {
      accountLink = createSignedOutLink();
      accountRoot.replaceWith(accountLink);
      accountRoot = null;
    }
  }

  document.addEventListener("click", function (event) {
    if (accountRoot && !accountRoot.contains(event.target)) closeMenu();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeMenu();
  });

  window.SNHSiteAuth.onAuthStateChange(function (_event, session) {
    render(session);
  });
  void window.SNHSiteAuth.getSession().then(render).catch(function (error) {
    console.warn("[SNH] Could not initialize account menu:", error);
  });
})();
