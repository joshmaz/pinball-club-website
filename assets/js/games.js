const IMAGE_BASE_PATH = "assets/images/machines";
const KINETICIST_ICON_PATH = "assets/images/icons/kineticist-k.png";
const PINSIDE_ICON_PATH = "assets/images/icons/pinside_logo-ball.png";
/** Rasterized from the www.ipdb.org favicon for consistency with other provider PNGs. */
const IPDB_ICON_PATH = "assets/images/icons/ipdb-favicon.png";
const GAMES_URL = "data/games.json";

/** Club opened Jan 2016; Pinball Map coverage starts 2017 — legacy imports often lack stint dates. */
const UNKNOWN_TENURE_SORT_JOIN = "2016-01-01";
const UNKNOWN_TENURE_SORT_LEFT_PREVIOUS = "2016-12-31";
/** Sort value for machines still on the floor (no leave date). */
const STILL_AT_CLUB_SORT_LEFT = "9999-12-31";

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function hasNonemptyString(v) {
  return v != null && String(v).trim() !== "";
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

function createGamesList(games) {
  const list = document.createElement("ul");
  list.className = "games-list";

  for (const game of games) {
    const item = document.createElement("li");
    item.className = "games-list-item";
    if (game && typeof game === "object" && game.atClub === true) {
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
    if (kineticistUrl || pinsideUrl || ipdbUrl) {
      const linkRow = document.createElement("div");
      linkRow.className = "games-actions";

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

      item.appendChild(linkRow);
    }

    list.appendChild(item);
  }

  return list;
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
    renderGamesList(sorted);
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
