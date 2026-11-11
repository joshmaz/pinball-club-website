/* Umami pageview tracking for the production site.
 *
 * Enable tracking on this browser:
 *   https://snhpinballclub.com/#umami-opt-in
 *
 * Disable tracking on this browser:
 *   https://snhpinballclub.com/#umami-opt-out
 */
(() => {
  const productionHosts = new Set(["snhpinballclub.com"]);
  if (!productionHosts.has(window.location.hostname.toLowerCase())) return;

  const path = window.location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  const isAccountPage = /^\/(members|signin)(\.html)?$/.test(path);
  const disabledKey = "umami.disabled";

  function applyToggleFromHash() {
    const hash = window.location.hash;
    if (hash !== "#umami-opt-out" && hash !== "#umami-opt-in") return null;
    try {
      if (hash === "#umami-opt-out") window.localStorage.setItem(disabledKey, "1");
      else window.localStorage.removeItem(disabledKey);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return hash === "#umami-opt-out" ? "off" : "on";
    } catch {
      return "unavailable";
    }
  }

  window.addEventListener("hashchange", () => {
    const action = applyToggleFromHash();
    if (action) window.location.reload();
  });

  const action = applyToggleFromHash();
  if (action === "off" || action === "unavailable") return;

  try {
    if (window.localStorage.getItem(disabledKey)) return;
  } catch {
    // If browser storage is unavailable, avoid collecting analytics.
    return;
  }

  const tracker = document.createElement("script");
  tracker.defer = true;
  tracker.src = "https://cloud.umami.is/script.js";
  tracker.dataset.websiteId = "2a9f77f1-d025-4e08-9178-e6f80adf2ad6";
  tracker.dataset.excludeHash = "true";
  if (isAccountPage) tracker.dataset.excludeSearch = "true";
  document.head.appendChild(tracker);
})();
