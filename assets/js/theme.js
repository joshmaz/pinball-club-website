/*
 * SNH Pinball Club theme controller.
 *
 * Public surface: window.SNHTheme = { get, set, cycle, PREFS }.
 *
 * Resolves a three-state user preference (light | dark | system) and
 * mirrors it onto <html> so CSS light-dark() and color-scheme can do the
 * rest. Runs synchronously at script load so the theme is in place before
 * the stylesheet paints, preventing flash-of-incorrect-theme.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "snh-theme";
  var PREFS = { LIGHT: "light", DARK: "dark", SYSTEM: "system" };
  var CYCLE_ORDER = [PREFS.LIGHT, PREFS.DARK, PREFS.SYSTEM];
  var PREF_LABELS = {
    light: "Light",
    dark: "Dark",
    system: "System",
  };

  var root = document.documentElement;
  var darkMql = null;
  try {
    if (typeof window.matchMedia === "function") {
      darkMql = window.matchMedia("(prefers-color-scheme: dark)");
    }
  } catch (err) {
    darkMql = null;
  }

  var memoryPref = null;

  function safeGetStored() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      if (value === PREFS.LIGHT || value === PREFS.DARK || value === PREFS.SYSTEM) {
        return value;
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  function safeSetStored(value) {
    try {
      if (value === PREFS.SYSTEM) {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, value);
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function getPref() {
    var stored = safeGetStored();
    if (stored) return stored;
    if (memoryPref) return memoryPref;
    return PREFS.SYSTEM;
  }

  function resolveTheme(pref) {
    if (pref === PREFS.LIGHT) return PREFS.LIGHT;
    if (pref === PREFS.DARK) return PREFS.DARK;
    if (darkMql && darkMql.matches) return PREFS.DARK;
    return PREFS.LIGHT;
  }

  function readThemeColorToken() {
    try {
      var token = getComputedStyle(root).getPropertyValue("--theme-color").trim();
      if (token) return token;
    } catch (err) {
      // ignore
    }
    return null;
  }

  function updateThemeColorMeta() {
    var color = readThemeColorToken();
    if (!color) return;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      var head = document.head || document.getElementsByTagName("head")[0];
      if (head) head.appendChild(meta);
    }
    meta.setAttribute("content", color);
  }

  function apply() {
    var pref = getPref();
    var resolved = resolveTheme(pref);

    if (pref === PREFS.SYSTEM) {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", resolved);
    }
    root.setAttribute("data-theme-pref", pref);
    root.setAttribute("data-theme-resolved", resolved);

    if (document.head) {
      updateThemeColorMeta();
    } else {
      document.addEventListener("DOMContentLoaded", updateThemeColorMeta, { once: true });
    }

    syncToggleUi();
  }

  function syncToggleUi() {
    var btn = document.querySelector("[data-theme-toggle]");
    if (!btn) return;
    var pref = getPref();
    var label = PREF_LABELS[pref] || PREF_LABELS.system;
    btn.setAttribute("aria-label", "Theme: " + label + " (click to change)");
    btn.setAttribute("data-theme-pref", pref);
    btn.setAttribute("title", "Theme: " + label);
  }

  function announce(pref) {
    var live = document.getElementById("snh-theme-live");
    if (!live) return;
    var label = PREF_LABELS[pref] || PREF_LABELS.system;
    live.textContent = "Theme set to " + label;
  }

  function setPref(value) {
    if (value !== PREFS.LIGHT && value !== PREFS.DARK && value !== PREFS.SYSTEM) {
      return;
    }
    memoryPref = value;
    safeSetStored(value);
    apply();
    announce(value);
  }

  function cyclePref() {
    var current = getPref();
    var idx = CYCLE_ORDER.indexOf(current);
    var next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
    setPref(next);
  }

  function buildToggle() {
    if (document.querySelector("[data-theme-toggle]")) return;
    var navs = document.querySelectorAll("header nav");
    if (!navs.length) return;
    var nav = navs[0];

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    btn.setAttribute("data-theme-toggle", "");
    btn.setAttribute("aria-label", "Theme: System (click to change)");

    var iconLight = document.createElement("span");
    iconLight.className = "theme-toggle-icon theme-toggle-icon--light";
    iconLight.setAttribute("aria-hidden", "true");
    iconLight.textContent = "\u2600"; // sun

    var iconDark = document.createElement("span");
    iconDark.className = "theme-toggle-icon theme-toggle-icon--dark";
    iconDark.setAttribute("aria-hidden", "true");
    iconDark.textContent = "\u263E"; // moon

    var iconSystem = document.createElement("span");
    iconSystem.className = "theme-toggle-icon theme-toggle-icon--system";
    iconSystem.setAttribute("aria-hidden", "true");
    iconSystem.textContent = "\u25D1"; // half-filled circle

    btn.appendChild(iconLight);
    btn.appendChild(iconDark);
    btn.appendChild(iconSystem);

    btn.addEventListener("click", function () {
      cyclePref();
    });

    nav.appendChild(btn);

    if (!document.getElementById("snh-theme-live")) {
      var live = document.createElement("div");
      live.id = "snh-theme-live";
      live.className = "sr-only";
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      live.setAttribute("aria-atomic", "true");
      document.body.appendChild(live);
    }

    syncToggleUi();
  }

  function onSystemThemeChange() {
    if (getPref() === PREFS.SYSTEM) {
      apply();
    }
  }

  function onStorage(event) {
    if (event.key !== STORAGE_KEY) return;
    apply();
  }

  apply();

  if (darkMql) {
    if (typeof darkMql.addEventListener === "function") {
      darkMql.addEventListener("change", onSystemThemeChange);
    } else if (typeof darkMql.addListener === "function") {
      darkMql.addListener(onSystemThemeChange);
    }
  }

  try {
    window.addEventListener("storage", onStorage);
  } catch (err) {
    // ignore
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildToggle, { once: true });
  } else {
    buildToggle();
  }

  window.SNHTheme = {
    PREFS: PREFS,
    get: getPref,
    set: setPref,
    cycle: cyclePref,
  };
})();
