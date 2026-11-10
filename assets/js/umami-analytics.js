/* Umami pageview tracking for the public production site.
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
  if (/^\/(members|signin)(\.html)?$/.test(path)) return;

  const disabledKey = "umami.disabled";
  try {
    if (window.location.hash === "#umami-opt-out") {
      window.localStorage.setItem(disabledKey, "1");
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return;
    }

    if (window.location.hash === "#umami-opt-in") {
      window.localStorage.removeItem(disabledKey);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    if (window.localStorage.getItem(disabledKey)) return;
  } catch {
    // If browser storage is unavailable, avoid collecting analytics.
    return;
  }

  const tracker = document.createElement("script");
  tracker.defer = true;
  tracker.src = "https://cloud.umami.is/script.js";
  tracker.dataset.websiteId = "2a9f77f1-d025-4e08-9178-e6f80adf2ad6";
  document.head.appendChild(tracker);
})();
