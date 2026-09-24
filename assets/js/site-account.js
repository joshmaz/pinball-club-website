/* Direct account navigation with sign-out in the shared header utility row. */
(function () {
  var accountLink = document.querySelector("[data-site-account-link]");
  var actions = document.querySelector("[data-site-account-actions]");
  if (!accountLink || !actions || !window.SNHSiteAuth) return;

  var signinHref = accountLink.getAttribute("href") || "signin.html";
  var pathPrefix = signinHref.slice(0, Math.max(0, signinHref.length - "signin.html".length));
  var dashboardHref = pathPrefix + "members.html";
  var signout = document.createElement("button");
  signout.type = "button";
  signout.className = "site-account-signout";
  signout.textContent = "Sign out";
  signout.hidden = true;
  var status = document.createElement("span");
  status.className = "site-account-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  actions.appendChild(signout);
  actions.appendChild(status);

  function render(session) {
    var signedIn = !!(session && session.user);
    accountLink.href = signedIn ? dashboardHref : signinHref;
    accountLink.textContent = signedIn ? "My Account" : "Members";
    var currentPage = window.location.pathname.split("/").pop();
    if (currentPage === (signedIn ? "members.html" : "signin.html")) {
      accountLink.setAttribute("aria-current", "page");
    } else {
      accountLink.removeAttribute("aria-current");
    }
    signout.hidden = !signedIn;
    if (!signedIn) status.textContent = "";
  }

  signout.addEventListener("click", async function () {
    signout.disabled = true;
    signout.textContent = "Signing out…";
    status.textContent = "Signing out.";
    try {
      await window.SNHSiteAuth.signOut();
      render(null);
      if (window.location.pathname.split("/").pop() === "members.html") {
        window.location.href = signinHref;
      } else {
        accountLink.focus();
      }
    } catch (error) {
      status.textContent = "Could not sign out. Please try again.";
      console.warn("[SNH] Sign out failed:", error);
    } finally {
      signout.disabled = false;
      signout.textContent = "Sign out";
    }
  });

  // Auth notifications take precedence over a pending initial session lookup.
  var authChanged = false;
  window.SNHSiteAuth.onAuthStateChange(function (_event, session) {
    authChanged = true;
    render(session);
  });
  void window.SNHSiteAuth.getSession().then(function (session) {
    if (!authChanged) render(session);
  }).catch(function (error) {
    console.warn("[SNH] Could not initialize account navigation:", error);
  });
})();
