const IMAGE_BASE_PATH = "assets/images/machines";
const KINETICIST_ICON_PATH = "assets/images/icons/kineticist-k.png";
const PINSIDE_ICON_PATH = "assets/images/icons/pinside_logo-ball.png";
/** Rasterized from the www.ipdb.org favicon for consistency with other provider PNGs. */
const IPDB_ICON_PATH = "assets/images/icons/ipdb-favicon.png";
const PINTIPS_ICON_PATH = "assets/images/icons/pintips-bulb.svg";
const GAMES_URL = "data/games.json";
const MATCHPLAY_OPDB_ENTRY_BASE_URL = "https://app.matchplay.events/opdb/entries";

/** Club opened Jan 2016; Pinball Map coverage starts 2017 — legacy imports often lack stint dates. */
const UNKNOWN_TENURE_SORT_JOIN = "2016-01-01";
const UNKNOWN_TENURE_SORT_LEFT_PREVIOUS = "2016-12-31";
/** Sort value for machines still on the floor (no leave date). */
const STILL_AT_CLUB_SORT_LEFT = "9999-12-31";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function hasNonemptyString(v) {
  return v != null && String(v).trim() !== "";
}

/**
 * Normalizes an optional game owner string in-place.
 * If owner is missing/blank, the field is removed.
 * If owner is a non-string value, the field is removed and a warning is logged.
 *
 * @param {{ title?: string, owner?: unknown }} game
 */
function normalizeGameOwner(game) {
  if (!("owner" in game)) {
    return;
  }
  const owner = game.owner;
  if (owner == null) {
    delete game.owner;
    return;
  }
  if (typeof owner !== "string") {
    console.warn(`Game "${String(game.title || "unknown")}" has invalid owner value; expected string.`);
    delete game.owner;
    return;
  }
  const trimmed = owner.trim();
  if (!trimmed) {
    delete game.owner;
    return;
  }
  game.owner = trimmed;
}

/**
 * Sets `dateUnknown`, `sortKeyJoined`, and `sortKeyLeft` on each stint for stable sorting.
 * `dateUnknown` is true when both real club dates are absent (legacy / pre–Pinball Map).
 * Sort keys are ISO date strings; they are editorial bounds for unknown tenure, not claims of fact.
 *
 * @param {{ joinedClubDate?: string, leftClubDate?: string, dateUnknown?: boolean, sortKeyJoined?: string, sortKeyLeft?: string }} stint
 * @param {boolean} stillAtClub from game `atClub` (Pinball Map); drives unknown-tenure sort bounds.
 */
function enrichLocationStint(stint, stillAtClub) {
  const hasJoin = hasNonemptyString(stint.joinedClubDate);
  const hasLeave = hasNonemptyString(stint.leftClubDate);
  const dateUnknown = !hasJoin && !hasLeave;
  stint.dateUnknown = dateUnknown;

  if (dateUnknown) {
    stint.sortKeyJoined = UNKNOWN_TENURE_SORT_JOIN;
    stint.sortKeyLeft = stillAtClub ? STILL_AT_CLUB_SORT_LEFT : UNKNOWN_TENURE_SORT_LEFT_PREVIOUS;
    return;
  }

  stint.sortKeyJoined = hasJoin ? String(stint.joinedClubDate).trim() : UNKNOWN_TENURE_SORT_JOIN;
  if (hasLeave) {
    stint.sortKeyLeft = String(stint.leftClubDate).trim();
  } else {
    stint.sortKeyLeft = stillAtClub ? STILL_AT_CLUB_SORT_LEFT : UNKNOWN_TENURE_SORT_LEFT_PREVIOUS;
  }
}

/**
 * @param {{ locationStints?: unknown[], atClub?: boolean }} game
 * @param {boolean} stillAtClub
 */
function enrichGameLocationStints(game, stillAtClub) {
  const stints = game.locationStints;
  if (!Array.isArray(stints)) {
    return;
  }
  for (const s of stints) {
    if (s && typeof s === "object") {
      enrichLocationStint(s, stillAtClub);
    }
  }
}

/**
 * @param {{ games?: unknown[] }} data
 */
function enrichGamesPayload(data) {
  const games = data.games;
  if (!Array.isArray(games)) {
    return;
  }
  for (const g of games) {
    if (g && typeof g === "object") {
      normalizeGameOwner(g);
      enrichGameLocationStints(g, g.atClub === true);
    }
  }
}

/**
 * Earliest stint start for this game (ISO), for chronological ordering.
 * @param {{ title?: string, locationStints?: { sortKeyJoined?: string }[] }} game
 * @returns {string}
 */
function gamePrimarySortKeyJoined(game) {
  const stints = game.locationStints;
  if (!Array.isArray(stints) || stints.length === 0) {
    return "9999-12-31";
  }
  let min = /** @type {string | null} */ (null);
  for (const s of stints) {
    if (s && typeof s === "object" && hasNonemptyString(s.sortKeyJoined)) {
      const k = String(s.sortKeyJoined).trim();
      if (min === null || k < min) {
        min = k;
      }
    }
  }
  return min != null ? min : "9999-12-31";
}

/**
 * Newest first by earliest stint `sortKeyJoined`, then title A–Z (stable).
 * @param {unknown[]} games
 * @returns {unknown[]}
 */
function sortGamesNewestJoinFirst(games) {
  if (!Array.isArray(games)) {
    return [];
  }
  const out = [...games];
  out.sort((a, b) => {
    if (!a || typeof a !== "object" || !b || typeof b !== "object") {
      return 0;
    }
    return String(a.title || "")
      .toLowerCase()
      .localeCompare(String(b.title || "").toLowerCase());
  });
  out.sort((a, b) => {
    if (!a || typeof a !== "object" || !b || typeof b !== "object") {
      return 0;
    }
    const ka = gamePrimarySortKeyJoined(a);
    const kb = gamePrimarySortKeyJoined(b);
    if (ka !== kb) {
      return ka < kb ? 1 : -1;
    }
    return 0;
  });
  return out;
}

/**
 * @param {{ address?: string, joinedClubDate?: string, leftClubDate?: string, pinballMapLocationId?: number, dateUnknown?: boolean }[]} stints
 */
function formatLocationStints(stints) {
  if (!Array.isArray(stints) || stints.length === 0) {
    return "";
  }
  const lines = [];
  for (const s of stints) {
    const where = (s.address && String(s.address).trim()) || "Club location";
    const from = s.joinedClubDate ? String(s.joinedClubDate).trim() : "";
    const through = s.leftClubDate ? String(s.leftClubDate).trim() : "";
    let line = where;
    if (from && through) {
      line += `: ${from} – ${through}`;
    } else if (from) {
      line += `: from ${from}`;
    } else if (through) {
      line += `: through ${through}`;
    }
    if (s.dateUnknown) {
      line += line === where ? " — tenure dates unknown" : " (tenure dates unknown)";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * @returns {string}
 */
function todayIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeIsoDateOrEmpty(value) {
  if (!hasNonemptyString(value)) {
    return "";
  }
  const iso = String(value).trim();
  return ISO_DATE_RE.test(iso) ? iso : "";
}

/**
 * @param {{ sortKeyJoined?: string, joinedClubDate?: string }} stint
 * @returns {string}
 */
function stintStartDate(stint) {
  return (
    normalizeIsoDateOrEmpty(stint.sortKeyJoined) ||
    normalizeIsoDateOrEmpty(stint.joinedClubDate) ||
    UNKNOWN_TENURE_SORT_JOIN
  );
}

/**
 * @param {{ sortKeyLeft?: string, leftClubDate?: string }} stint
 * @param {boolean} stillAtClub
 * @returns {string}
 */
function stintEndDate(stint, stillAtClub) {
  return (
    normalizeIsoDateOrEmpty(stint.sortKeyLeft) ||
    normalizeIsoDateOrEmpty(stint.leftClubDate) ||
    (stillAtClub ? STILL_AT_CLUB_SORT_LEFT : UNKNOWN_TENURE_SORT_LEFT_PREVIOUS)
  );
}

/**
 * @param {{ locationStints?: unknown[], atClub?: boolean }} game
 * @param {string} targetIsoDate
 * @returns {boolean}
 */
function isGameActiveOnDate(game, targetIsoDate) {
  if (!game || typeof game !== "object") {
    return false;
  }
  const stints = game.locationStints;
  if (!Array.isArray(stints) || stints.length === 0) {
    return false;
  }
  const stillAtClub = game.atClub === true;
  for (const stint of stints) {
    if (!stint || typeof stint !== "object") {
      continue;
    }
    const start = stintStartDate(stint);
    const end = stintEndDate(stint, stillAtClub);
    if (start <= targetIsoDate && targetIsoDate <= end) {
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown[]} games
 * @returns {string[]}
 */
function buildTimelineDates(games) {
  const markers = new Set();
  for (const game of games) {
    if (!game || typeof game !== "object" || !Array.isArray(game.locationStints)) {
      continue;
    }
    const stillAtClub = game.atClub === true;
    for (const stint of game.locationStints) {
      if (!stint || typeof stint !== "object") {
        continue;
      }
      markers.add(stintStartDate(stint));
      const end = stintEndDate(stint, stillAtClub);
      if (end !== STILL_AT_CLUB_SORT_LEFT) {
        markers.add(end);
      }
    }
  }

  markers.add(todayIsoDate());
  const dates = Array.from(markers);
  dates.sort((a, b) => (a === b ? 0 : a < b ? 1 : -1));
  return dates;
}

/**
 * @param {string[]} timelineDates
 * @param {string} targetIso
 * @returns {number}
 */
function findClosestTimelineIndex(timelineDates, targetIso) {
  for (let i = 0; i < timelineDates.length; i += 1) {
    if (timelineDates[i] <= targetIso) {
      return i;
    }
  }
  return Math.max(0, timelineDates.length - 1);
}

/**
 * @param {string} isoDate
 * @returns {string}
 */
function formatDateLabel(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? isoDate
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * @param {unknown[]} games
 * @returns {Set<string>}
 */
function gameTitleSet(games) {
  return new Set(
    games
      .filter((game) => game && typeof game === "object" && hasNonemptyString(game.title))
      .map((game) => String(game.title))
  );
}

function createGamesList(games) {
  const list = document.createElement("ul");
  list.className = "games-list";

  for (const game of games) {
    const item = document.createElement("li");
    item.className = "games-list-item";
    const isAtClub = game && typeof game === "object" && game.atClub === true;
    if (isAtClub) {
      item.classList.add("games-list-item--at-club");
    }

    const title = document.createElement("strong");
    title.textContent = game.title;
    item.appendChild(title);

    const filename = game.imageFilename;
    const imagePath = filename ? `${IMAGE_BASE_PATH}/${filename}` : "";
    if (imagePath) {
      const image = document.createElement("img");
      image.className = "game-card-image";
      image.src = imagePath;
      image.alt = game.title;
      image.loading = "lazy";
      item.appendChild(image);
    }

    const details = document.createElement("p");
    details.className = "games-details";
    details.textContent = game.details;
    item.appendChild(details);

    const stintsText = formatLocationStints(game.locationStints);
    if (stintsText) {
      const stintsEl = document.createElement("p");
      stintsEl.className = "games-location-stints";
      stintsEl.textContent = stintsText;
      item.appendChild(stintsEl);
    }

    const kineticistUrl = game.kineticistUrl;
    const pinsideUrl = game.pinsideUrl;
    const ipdbUrl = game.ipdbUrl;
    const pintipsUrl = getPinTipsUrl(game);
    if (kineticistUrl || pinsideUrl || ipdbUrl || pintipsUrl || isAtClub) {
      const linkRow = document.createElement("div");
      linkRow.className = "games-actions";

      if (isAtClub) {
        const badge = document.createElement("span");
        badge.className = "games-status-badge";
        badge.textContent = "At club";
        linkRow.appendChild(badge);
      }

      if (kineticistUrl) {
        const kineticistLink = document.createElement("a");
        kineticistLink.className = "games-provider-link games-kineticist-link";
        kineticistLink.href = kineticistUrl;
        kineticistLink.target = "_blank";
        kineticistLink.rel = "noopener";
        kineticistLink.title = `View ${game.title} on Kineticist`;
        kineticistLink.setAttribute("aria-label", `View ${game.title} on Kineticist`);

        const kineticistIcon = document.createElement("img");
        kineticistIcon.className = "games-provider-icon";
        kineticistIcon.src = KINETICIST_ICON_PATH;
        kineticistIcon.alt = "";
        kineticistIcon.loading = "lazy";
        kineticistIcon.decoding = "async";
        kineticistLink.appendChild(kineticistIcon);

        linkRow.appendChild(kineticistLink);
      }

      if (pinsideUrl) {
        const pinsideLink = document.createElement("a");
        pinsideLink.className = "games-provider-link games-pinside-link";
        pinsideLink.href = pinsideUrl;
        pinsideLink.target = "_blank";
        pinsideLink.rel = "noopener";
        pinsideLink.title = `View ${game.title} on Pinside`;
        pinsideLink.setAttribute("aria-label", `View ${game.title} on Pinside`);

        const pinsideIcon = document.createElement("img");
        pinsideIcon.className = "games-provider-icon";
        pinsideIcon.src = PINSIDE_ICON_PATH;
        pinsideIcon.alt = "";
        pinsideIcon.loading = "lazy";
        pinsideIcon.decoding = "async";
        pinsideLink.appendChild(pinsideIcon);

        linkRow.appendChild(pinsideLink);
      }

      if (ipdbUrl) {
        const ipdbLink = document.createElement("a");
        ipdbLink.className = "games-provider-link games-ipdb-link";
        ipdbLink.href = ipdbUrl;
        ipdbLink.target = "_blank";
        ipdbLink.rel = "noopener";
        ipdbLink.title = `View ${game.title} on the Internet Pinball Database`;
        ipdbLink.setAttribute("aria-label", `View ${game.title} on the Internet Pinball Database`);

        const ipdbIcon = document.createElement("img");
        ipdbIcon.className = "games-provider-icon";
        ipdbIcon.src = IPDB_ICON_PATH;
        ipdbIcon.alt = "";
        ipdbIcon.loading = "lazy";
        ipdbIcon.decoding = "async";
        ipdbLink.appendChild(ipdbIcon);

        linkRow.appendChild(ipdbLink);
      }

      if (pintipsUrl) {
        const pintipsLink = document.createElement("a");
        pintipsLink.className = "games-provider-link games-pintips-link";
        pintipsLink.href = pintipsUrl;
        pintipsLink.target = "_blank";
        pintipsLink.rel = "noopener";
        pintipsLink.title = `View ${game.title} PinTips on Match Play Events`;
        pintipsLink.setAttribute("aria-label", `View ${game.title} PinTips on Match Play Events`);

        const pintipsIcon = document.createElement("img");
        pintipsIcon.className = "games-provider-icon";
        pintipsIcon.src = PINTIPS_ICON_PATH;
        pintipsIcon.alt = "";
        pintipsIcon.loading = "lazy";
        pintipsIcon.decoding = "async";
        pintipsLink.appendChild(pintipsIcon);

        linkRow.appendChild(pintipsLink);
      }

      item.appendChild(linkRow);
    }

    list.appendChild(item);
  }

  return list;
}

/**
 * @param {{ opdbId?: unknown }} game
 * @returns {string}
 */
function getPinTipsUrl(game) {
  if (!game || typeof game !== "object") {
    return "";
  }
  if (!hasNonemptyString(game.opdbId)) {
    return "";
  }
  const opdbId = String(game.opdbId).trim();
  return `${MATCHPLAY_OPDB_ENTRY_BASE_URL}/${encodeURIComponent(opdbId)}/pintips`;
}

function showMessage(container, title, details) {
  container.replaceChildren();
  const card = document.createElement("div");
  card.className = "games-list-item";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const p = document.createElement("p");
  p.textContent = details;
  card.appendChild(h3);
  card.appendChild(p);
  container.appendChild(card);
}

function renderGamesList(games) {
  const container = document.getElementById("games-list");
  if (container) {
    container.replaceChildren(createGamesList(games));
  }
}

async function loadGames() {
  const container = document.getElementById("games-list");
  const transitionBanner = document.getElementById("games-transition-banner");
  const timelineControls = document.querySelector(".games-timeline-controls");
  const timelineRange = document.getElementById("games-timeline-range");
  const timelineStatus = document.getElementById("games-timeline-status");
  const dateInput = document.getElementById("games-date-input");
  const dateApplyButton = document.getElementById("games-date-apply");
  const showAllCheckbox = document.getElementById("games-show-all");
  if (!container) {
    console.error("Games list container was not found.");
    return;
  }

  try {
    const response = await fetch(GAMES_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status} ${response.statusText}) for ${GAMES_URL}`);
    }

    const data = await response.json();
    if (!data || typeof data !== "object") {
      throw new Error(`Invalid data in ${GAMES_URL}`);
    }
    if (!Array.isArray(data.games)) {
      throw new Error(`Invalid data format in ${GAMES_URL}: expected a games array.`);
    }

    enrichGamesPayload(data);
    const sorted = sortGamesNewestJoinFirst(data.games);
    const hasAnyAtClub = sorted.some((game) => game && typeof game === "object" && game.atClub === true);
    const timelineDates = buildTimelineDates(sorted);
    const todayIso = todayIsoDate();
    let priorGames = [];
    let hasRenderedSnapshot = false;
    let showAllMode = !hasAnyAtClub;

    if (transitionBanner) {
      transitionBanner.hidden = hasAnyAtClub;
    }

    /**
     * @param {string} selectedIso
     * @param {boolean} fromCustomDate
     */
    function renderSnapshot(selectedIso, fromCustomDate) {
      if (showAllMode) {
        renderGamesList(sorted);
        if (timelineStatus) {
          timelineStatus.textContent = hasAnyAtClub
            ? `All history \u00b7 ${sorted.length} games`
            : `All history \u00b7 ${sorted.length} games \u00b7 currently between locations`;
        }
        priorGames = sorted;
        hasRenderedSnapshot = true;
        return;
      }
      const activeGames = sorted.filter((game) => isGameActiveOnDate(game, selectedIso));
      const previousTitles = gameTitleSet(priorGames);
      const activeTitles = gameTitleSet(activeGames);
      const added = activeGames.filter((game) => !previousTitles.has(String(game.title))).length;
      const removed = priorGames.filter((game) => !activeTitles.has(String(game.title))).length;
      priorGames = activeGames;
      if (activeGames.length === 0) {
        showMessage(
          container,
          "Between locations",
          "No games were active at the club on this date."
        );
      } else {
        renderGamesList(activeGames);
      }

      if (timelineStatus) {
        const lead = selectedIso === todayIso ? "Now" : formatDateLabel(selectedIso);
        const via = fromCustomDate ? " (custom date)" : "";
        const delta = hasRenderedSnapshot && (added || removed)
          ? ` \u00b7 +${added} / -${removed} vs previous view`
          : "";
        timelineStatus.textContent = `${lead}${via} \u00b7 ${activeGames.length} games${delta}`;
      }
      hasRenderedSnapshot = true;
    }

    function setTimelineControlsEnabled(enabled) {
      if (timelineControls) {
        timelineControls.classList.toggle("games-timeline-controls--disabled", !enabled);
      }
      if (timelineRange) {
        timelineRange.disabled = !enabled;
      }
      if (dateInput) {
        dateInput.disabled = !enabled;
      }
      if (dateApplyButton) {
        dateApplyButton.disabled = !enabled;
      }
    }

    if (timelineRange && timelineDates.length > 0) {
      timelineRange.min = "0";
      timelineRange.max = String(timelineDates.length - 1);
      timelineRange.value = "0";
      timelineRange.addEventListener("input", () => {
        const idx = Number(timelineRange.value);
        const selected = timelineDates[idx] || todayIso;
        if (dateInput) {
          dateInput.value = selected;
        }
        renderSnapshot(selected, false);
      });
    }

    if (dateInput) {
      dateInput.value = todayIso;
      dateInput.min = timelineDates[timelineDates.length - 1] || "";
      dateInput.max = todayIso;
    }

    if (dateApplyButton) {
      dateApplyButton.addEventListener("click", () => {
        if (!dateInput) {
          return;
        }
        const selected = normalizeIsoDateOrEmpty(dateInput.value);
        if (!selected) {
          return;
        }
        if (timelineRange && timelineDates.length > 0) {
          const idx = findClosestTimelineIndex(timelineDates, selected);
          timelineRange.value = String(idx);
        }
        renderSnapshot(selected, true);
      });
    }

    if (showAllCheckbox) {
      showAllCheckbox.checked = showAllMode;
      showAllCheckbox.addEventListener("change", () => {
        showAllMode = showAllCheckbox.checked;
        setTimelineControlsEnabled(!showAllMode);
        if (showAllMode) {
          renderSnapshot(todayIso, false);
          return;
        }
        const selected = dateInput ? normalizeIsoDateOrEmpty(dateInput.value) : "";
        renderSnapshot(selected || todayIso, false);
      });
    }

    setTimelineControlsEnabled(!showAllMode);
    renderSnapshot(todayIso, false);
  } catch (error) {
    console.error("Error loading games:", error);
    showMessage(
      container,
      "Unable to load games",
      `We could not load the games list right now. Details: ${error.message}`
    );
  }
}

loadGames();
