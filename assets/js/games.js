const KINETICIST_ICON_PATH = "assets/images/icons/kineticist-k.png";
const PINSIDE_ICON_PATH = "assets/images/icons/pinside_logo-ball.png";
/** Rasterized from the www.ipdb.org favicon for consistency with other provider PNGs. */
const IPDB_ICON_PATH = "assets/images/icons/ipdb-favicon.png";
const PINTIPS_ICON_PATH = "assets/images/icons/pintips-bulb.svg";
let gamesCanManage = false;

async function currentUserCanManageGames() {
  if (!window.SNHSiteAuth) return false;
  try {
    const session = await window.SNHSiteAuth.getSession();
    if (!session || !session.user) return false;
    const roles = await window.SNHSiteAuth.fetchMemberRoles(session.user.id);
    return window.SNHSiteAuth.can(roles, "games.manage");
  } catch (error) {
    console.warn("[SNH] Could not resolve Games edit access:", error);
    return false;
  }
}

function gameEditorHref(game) {
  if (!gameHasCatalogUuid(game)) return "";
  return `members.html?panel=games&game=${encodeURIComponent(String(game.id))}`;
}
const MATCHPLAY_OPDB_ENTRY_BASE_URL = "https://app.matchplay.events/opdb/entries";

async function fetchGamesCatalogPayload() {
  const result = await window.SNHPublicData.loadGames();
  const container = document.getElementById('games-list');
  if (container) {
    let note = document.getElementById('games-data-source-note');
    if (!note) {
      note = document.createElement('p');
      note.id = 'games-data-source-note';
      container.before(note);
    }
    note.hidden = true;
    void currentUserCanManageGames().then((allowed) => {
      note.hidden = !allowed;
      if (allowed) note.textContent = window.SNHPublicData.sourceLabel(result);
    });
  }
  return { games: result.data };
}

/** Club opened Jan 2016; Pinball Map coverage starts 2017, so legacy imports often lack stint dates. */
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
 * Public game images come from the normalized game_images resolver.
 * Reference-only images never appear in the public catalog payload.
 * @param {{ title?: unknown, primaryImage?: unknown }} game
 * @returns {{ url: string, altText: string, sourceType: string, attributionText: string, attributionUrl: string, licenseName: string, licenseUrl: string } | null}
 */
function resolveGameImage(game) {
  if (!game || typeof game !== "object") return null;
  const normalized = game.primaryImage;
  if (normalized && typeof normalized === "object" && hasNonemptyString(normalized.url)) {
    return {
      url: String(normalized.url).trim(),
      altText: hasNonemptyString(normalized.altText) ? String(normalized.altText).trim() : String(game.title || ""),
      sourceType: hasNonemptyString(normalized.sourceType) ? String(normalized.sourceType).trim() : "external",
      attributionText: hasNonemptyString(normalized.attributionText) ? String(normalized.attributionText).trim() : "",
      attributionUrl: hasNonemptyString(normalized.attributionUrl)
        ? String(normalized.attributionUrl).trim()
        : hasNonemptyString(normalized.sourceUrl)
          ? String(normalized.sourceUrl).trim()
          : "",
      licenseName: hasNonemptyString(normalized.licenseName) ? String(normalized.licenseName).trim() : "",
      licenseUrl: hasNonemptyString(normalized.licenseUrl) ? String(normalized.licenseUrl).trim() : "",
    };
  }
  return null;
}

function createGameImageFigure(game) {
  const selected = resolveGameImage(game);
  if (!selected) return null;

  const figure = document.createElement("figure");
  figure.className = "game-card-figure";
  const image = document.createElement("img");
  image.className = "game-card-image";
  image.src = selected.url;
  image.alt = selected.altText;
  image.loading = "lazy";
  image.decoding = "async";
  figure.appendChild(image);

  if (selected.sourceType !== "club" && selected.attributionText) {
    const credit = document.createElement("figcaption");
    credit.className = "game-card-image-credit";
    credit.append("Image: ");
    if (selected.attributionUrl) {
      const source = document.createElement("a");
      source.href = selected.attributionUrl;
      source.target = "_blank";
      source.rel = "noopener";
      source.textContent = selected.attributionText;
      credit.appendChild(source);
    } else {
      credit.append(selected.attributionText);
    }
    if (selected.licenseName) {
      credit.append(" · ");
      if (selected.licenseUrl) {
        const license = document.createElement("a");
        license.href = selected.licenseUrl;
        license.target = "_blank";
        license.rel = "noopener";
        license.textContent = selected.licenseName;
        credit.appendChild(license);
      } else {
        credit.append(selected.licenseName);
      }
    }
    figure.appendChild(credit);
  }
  return figure;
}

/**
 * @param {unknown} v
 * @returns {boolean | null}
 */
function normalizeOptionalBoolean(v) {
  return typeof v === "boolean" ? v : null;
}

/**
 * Manual overrides win over map-derived status; fallback keeps legacy payloads working.
 * @param {{ manualAtClubOverride?: unknown, mapAtClub?: unknown, atClub?: unknown }} game
 * @returns {boolean}
 */
function resolveGameAtClub(game) {
  const manual = normalizeOptionalBoolean(game.manualAtClubOverride);
  if (manual !== null) {
    return manual;
  }
  const mapAtClub = normalizeOptionalBoolean(game.mapAtClub);
  if (mapAtClub !== null) {
    return mapAtClub;
  }
  return game.atClub === true;
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
      // Preserve legacy consumers while supporting map + manual override fields.
      g.atClub = resolveGameAtClub(g);
      enrichGameLocationStints(g, g.atClub === true);
    }
  }
}

/**
 * Keep soft-deleted games hidden in all public views.
 * @param {unknown} game
 * @returns {boolean}
 */
function isSoftDeletedGame(game) {
  if (!game || typeof game !== "object") {
    return false;
  }
  const deletedAt = game.deletedAt ?? game.deleted_at;
  return hasNonemptyString(deletedAt);
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
      line += line === where ? ", tenure dates unknown" : " (tenure dates unknown)";
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
 * Thousands separators for display (pinball scores are integers).
 * @param {unknown} score
 * @returns {string}
 */
function formatHighScoreDisplay(score) {
  if (score == null) return "";
  const n = typeof score === "number" ? score : Number(String(score).replace(/,/g, ""));
  if (Number.isNaN(n)) return String(score);
  return n.toLocaleString(undefined);
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

/** Stable catalog id from DB export or games_catalog_v1 (uuid string). */
const GAME_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getPublicSupabaseClient() {
  const client = window.snhSupabase;
  if (!client || typeof client.rpc !== "function") {
    return null;
  }
  return client;
}

/**
 * @param {{ id?: unknown }} game
 * @returns {boolean}
 */
function gameHasCatalogUuid(game) {
  if (!game || typeof game !== "object") {
    return false;
  }
  const raw = game.id;
  if (typeof raw !== "string") {
    return false;
  }
  return GAME_UUID_RE.test(raw.trim());
}

const gameMoreInfoUi = {
  root: /** @type {HTMLElement | null} */ (null),
  dialog: /** @type {HTMLElement | null} */ (null),
  titleEl: /** @type {HTMLElement | null} */ (null),
  bodyEl: /** @type {HTMLElement | null} */ (null),
  lastFocus: /** @type {HTMLElement | null} */ (null),
  onKeyDown: /** @type {((e: KeyboardEvent) => void) | null} */ (null),
  requestId: 0,
};

function ensureGameMoreInfoModal() {
  if (gameMoreInfoUi.root) {
    return;
  }
  const root = document.createElement("div");
  root.id = "games-more-info-root";
  root.className = "games-more-info-root";
  root.hidden = true;

  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "games-more-info-backdrop";
  backdrop.setAttribute("aria-label", "Close details");
  backdrop.addEventListener("click", () => closeGameMoreInfoModal());

  const dialog = document.createElement("div");
  dialog.className = "games-more-info-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "games-more-info-title");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "games-more-info-close";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => closeGameMoreInfoModal());

  const titleEl = document.createElement("h3");
  titleEl.id = "games-more-info-title";
  titleEl.className = "games-more-info-title";

  const bodyEl = document.createElement("div");
  bodyEl.className = "games-more-info-body";

  dialog.appendChild(closeBtn);
  dialog.appendChild(titleEl);
  dialog.appendChild(bodyEl);
  root.appendChild(backdrop);
  root.appendChild(dialog);
  document.body.appendChild(root);

  gameMoreInfoUi.root = root;
  gameMoreInfoUi.dialog = dialog;
  gameMoreInfoUi.titleEl = titleEl;
  gameMoreInfoUi.bodyEl = bodyEl;
}

/**
 * @param {number | null | undefined} cents
 * @returns {string}
 */
function formatMoneyFromCents(cents) {
  if (cents == null || Number.isNaN(Number(cents))) {
    return "";
  }
  const n = Number(cents) / 100;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

/**
 * @param {unknown} payload
 */
function renderGameMoreInfoSections(payload, body, kind) {
  if (!payload || typeof payload !== "object") return;

  const highScores = payload.highScores;
  const pingolfTargets = payload.pingolfTargets;
  const customMods = payload.customMods;
  const saleListingPublic = payload.saleListingPublic;
  const partySummaries = payload.partySummaries;

  let any = false;

  /**
   * @param {string} heading
   * @param {HTMLElement} inner
   */
  function addSection(heading, inner) {
    const sec = document.createElement("section");
    sec.className = "games-more-info-section";
    const h = document.createElement("h4");
    h.textContent = heading;
    sec.appendChild(h);
    sec.appendChild(inner);
    body.appendChild(sec);
    any = true;
  }

  if (kind === "play" && Array.isArray(highScores) && highScores.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "games-more-info-list";
    for (const row of highScores) {
      if (!row || typeof row !== "object") continue;
      const li = document.createElement("li");
      const parts = [
        row.score != null ? formatHighScoreDisplay(row.score) : "",
        hasNonemptyString(row.playerLabel) ? String(row.playerLabel) : "",
        hasNonemptyString(row.achievedOn) ? formatDateLabel(String(row.achievedOn)) : "",
      ].filter(Boolean);
      li.textContent = parts.join(" · ");
      if (hasNonemptyString(row.notes)) {
        li.textContent += `: ${String(row.notes)}`;
      }
      ul.appendChild(li);
    }
    addSection("High scores", ul);
  }

  if (kind === "play" && Array.isArray(pingolfTargets) && pingolfTargets.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "games-more-info-list";
    for (const row of pingolfTargets) {
      if (!row || typeof row !== "object") continue;
      const li = document.createElement("li");
      let t = hasNonemptyString(row.description) ? String(row.description) : "Target";
      if (row.targetValue != null && row.targetValue !== "") {
        t += ` (goal: ${row.targetValue})`;
      }
      li.textContent = t;
      ul.appendChild(li);
    }
    addSection("Pingolf", ul);
  }

  if (kind === "overview" && Array.isArray(partySummaries) && partySummaries.some((x) => hasNonemptyString(x))) {
    const ul = document.createElement("ul");
    ul.className = "games-more-info-list";
    for (const line of partySummaries) {
      if (!hasNonemptyString(line)) continue;
      const li = document.createElement("li");
      li.textContent = String(line);
      ul.appendChild(li);
    }
    addSection("Owners & lenders", ul);
  }

  if (kind === "overview" && saleListingPublic && typeof saleListingPublic === "object") {
    const p = document.createElement("p");
    p.className = "games-more-info-sale";
    const bits = [];
    if (hasNonemptyString(saleListingPublic.status)) {
      bits.push(String(saleListingPublic.status));
    }
    const centsRaw = saleListingPublic.askingPriceCents;
    const price = formatMoneyFromCents(
      typeof centsRaw === "number" ? centsRaw : centsRaw != null ? Number(centsRaw) : null
    );
    if (price) bits.push(`Asking ${price}`);
    p.textContent = bits.join(" · ");
    if (hasNonemptyString(saleListingPublic.notes)) {
      const note = document.createElement("span");
      note.className = "games-more-info-sale-notes";
      note.textContent = String(saleListingPublic.notes);
      p.appendChild(document.createElement("br"));
      p.appendChild(note);
    }
    addSection("For sale", p);
  }

  if (kind === "overview" && Array.isArray(customMods) && customMods.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "games-more-info-list";
    for (const row of customMods) {
      if (!row || typeof row !== "object") continue;
      const li = document.createElement("li");
      const title = hasNonemptyString(row.title) ? String(row.title) : "Mod";
      if (hasNonemptyString(row.referenceUrl)) {
        const a = document.createElement("a");
        a.href = String(row.referenceUrl);
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = title;
        li.appendChild(a);
      } else {
        li.textContent = title;
      }
      if (hasNonemptyString(row.description)) {
        li.appendChild(document.createTextNode(`: ${String(row.description)}`));
      }
      ul.appendChild(li);
    }
    addSection("Custom mods", ul);
  }

  return any;
}

function closeGameMoreInfoModal() {
  gameMoreInfoUi.requestId += 1;
  if (gameMoreInfoUi.onKeyDown) {
    document.removeEventListener("keydown", gameMoreInfoUi.onKeyDown);
    gameMoreInfoUi.onKeyDown = null;
  }
  if (gameMoreInfoUi.root) {
    gameMoreInfoUi.root.hidden = true;
  }
  if (gameMoreInfoUi.lastFocus && typeof gameMoreInfoUi.lastFocus.focus === "function") {
    gameMoreInfoUi.lastFocus.focus();
  }
  gameMoreInfoUi.lastFocus = null;
}

function addGameProfileLink(row, label, url) {
  if (!hasNonemptyString(url)) return;
  const link = document.createElement("a");
  link.href = String(url);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  row.appendChild(link);
}

function renderGameProfile(game, payload, error) {
  const body = gameMoreInfoUi.bodyEl;
  if (!body) return;
  const selectedLabel = body.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
  body.replaceChildren();
  const tabs = document.createElement("div");
  tabs.className = "games-profile-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Game profile sections");
  const panels = [];
  function addTab(label, panel) {
    const index = panels.length;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "games-profile-tab";
    tab.id = `games-profile-tab-${index}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `games-profile-panel-${index}`);
    panel.id = `games-profile-panel-${index}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    tab.textContent = label;
    tabs.appendChild(tab);
    panels.push({ tab, panel });
    tab.addEventListener("click", () => activate(index));
    tab.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : null;
      if (next === null) return;
      event.preventDefault();
      activate((next + panels.length) % panels.length);
      panels[(next + panels.length) % panels.length].tab.focus();
    });
  }
  function activate(index) {
    panels.forEach(({ tab, panel }, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panel.hidden = i !== index;
    });
  }

  const overview = document.createElement("div");
  overview.className = "games-profile-panel";
  const figure = createGameImageFigure(game);
  if (hasNonemptyString(game.details)) {
    const section = document.createElement("section");
    section.className = "games-more-info-section";
    const heading = document.createElement("h4");
    heading.textContent = "Description";
    const details = document.createElement("p");
    details.textContent = String(game.details);
    section.append(heading, details);
    overview.appendChild(section);
  }
  const stints = formatLocationStints(game.locationStints);
  if (stints) {
    const section = document.createElement("section");
    section.className = "games-more-info-section";
    const heading = document.createElement("h4");
    heading.textContent = "Club stints";
    const list = document.createElement("ul");
    list.className = "games-more-info-list";
    for (const line of stints.split("\n")) {
      const item = document.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    }
    section.append(heading, list);
    overview.appendChild(section);
  }
  const links = document.createElement("div");
  links.className = "games-profile-links";
  addGameProfileLink(links, "Kineticist", game.kineticistUrl);
  addGameProfileLink(links, "Pinside", game.pinsideUrl);
  addGameProfileLink(links, "IPDB", game.ipdbUrl);
  addGameProfileLink(links, "PinTips", getPinTipsUrl(game));
  if (links.childElementCount) {
    const section = document.createElement("section");
    section.className = "games-more-info-section";
    const heading = document.createElement("h4");
    heading.textContent = "Explore this game";
    const description = document.createElement("p");
    description.className = "games-profile-links-description";
    description.textContent = "Find more game details, community information, and playing tips through these sites.";
    section.append(heading, description, links);
    overview.appendChild(section);
  }
  renderGameMoreInfoSections(payload, overview, "overview");
  if (error) {
    const note = document.createElement("p");
    note.className = "games-more-info-error";
    note.textContent = "Additional game information could not be loaded.";
    overview.appendChild(note);
  }
  addTab("Overview", overview);

  if (figure) {
    const photos = document.createElement("div");
    photos.className = "games-profile-panel games-profile-photos";
    photos.appendChild(figure);
    addTab("Photos", photos);
  }
  const play = document.createElement("div");
  play.className = "games-profile-panel";
  if (renderGameMoreInfoSections(payload, play, "play")) addTab("Play", play);
  body.appendChild(tabs);
  panels.forEach(({ panel }) => body.appendChild(panel));
  activate(Math.max(0, panels.findIndex(({ tab }) => tab.textContent === selectedLabel)));
}

/** @param {{ title?: string, id?: string }} game */
async function openGameMoreInfoModal(game) {
  ensureGameMoreInfoModal();
  const root = gameMoreInfoUi.root;
  const titleEl = gameMoreInfoUi.titleEl;
  const dialog = gameMoreInfoUi.dialog;
  if (!root || !titleEl || !dialog) return;
  const requestId = ++gameMoreInfoUi.requestId;
  gameMoreInfoUi.lastFocus = /** @type {HTMLElement} */ (document.activeElement);
  root.hidden = false;
  titleEl.textContent = game.title ? `More about ${game.title}` : "Game details";
  renderGameProfile(game, null, false);
  gameMoreInfoUi.onKeyDown = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeGameMoreInfoModal();
    }
  };
  document.addEventListener("keydown", gameMoreInfoUi.onKeyDown);
  dialog.querySelector(".games-more-info-close")?.focus();

  const client = getPublicSupabaseClient();
  if (!client || !gameHasCatalogUuid(game)) return;
  try {
    const res = await client.rpc("snh_public_game_more_info", { p_game_id: game.id });
    if (res.error) throw new Error(res.error.message || String(res.error));
    let data = res.data;
    if (typeof data === "string") data = JSON.parse(data);
    if (!root.hidden && requestId === gameMoreInfoUi.requestId) renderGameProfile(game, data, false);
  } catch (err) {
    console.error("More Info RPC failed:", err);
    if (!root.hidden && requestId === gameMoreInfoUi.requestId) renderGameProfile(game, null, true);
  }
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

    const imageFigure = createGameImageFigure(game);
    if (imageFigure) {
      const image = imageFigure.querySelector(".game-card-image");
      if (image) {
        const imageButton = document.createElement("button");
        imageButton.type = "button";
        imageButton.className = "game-card-image-button";
        imageButton.setAttribute("aria-label", `More info about ${game.title}`);
        imageButton.setAttribute("aria-haspopup", "dialog");
        imageButton.addEventListener("click", () => {
          void openGameMoreInfoModal(game);
        });
        image.replaceWith(imageButton);
        imageButton.appendChild(image);
      }
      item.appendChild(imageFigure);
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
    const moreInfoEligible = true;
    const editHref = gamesCanManage ? gameEditorHref(game) : "";
    if (kineticistUrl || pinsideUrl || ipdbUrl || pintipsUrl || isAtClub || moreInfoEligible || editHref) {
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

      if (moreInfoEligible) {
        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "games-more-info-btn";
        moreBtn.textContent = "More info";
        moreBtn.setAttribute("aria-haspopup", "dialog");
        moreBtn.addEventListener("click", () => {
          void openGameMoreInfoModal(game);
        });
        linkRow.appendChild(moreBtn);
      }

      if (editHref) {
        const editLink = document.createElement("a");
        editLink.className = "games-more-info-btn games-edit-link";
        editLink.href = editHref;
        editLink.textContent = "Edit";
        editLink.setAttribute("aria-label", `Edit ${game.title} in Member Tools`);
        linkRow.appendChild(editLink);
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
    const data = await fetchGamesCatalogPayload();

    enrichGamesPayload(data);
    const visibleGames = (Array.isArray(data.games) ? data.games : []).filter(
      (game) => !isSoftDeletedGame(game)
    );
    const sorted = sortGamesNewestJoinFirst(visibleGames);
    const hasAnyAtClub = sorted.some((game) => game && typeof game === "object" && game.atClub === true);
    const timelineDates = buildTimelineDates(sorted);
    const todayIso = todayIsoDate();
    let priorGames = [];
    let hasRenderedSnapshot = false;
    let showAllMode = false;

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

    void currentUserCanManageGames().then((allowed) => {
      if (allowed === gamesCanManage) return;
      gamesCanManage = allowed;
      const selected = dateInput ? normalizeIsoDateOrEmpty(dateInput.value) : "";
      renderSnapshot(selected || todayIso, false);
    });
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
