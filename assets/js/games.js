const KINETICIST_ICON_PATH = "assets/images/icons/kineticist-k.png";
const PINSIDE_ICON_PATH = "assets/images/icons/pinside_logo-ball.png";
/** Rasterized from the www.ipdb.org favicon for consistency with other provider PNGs. */
const IPDB_ICON_PATH = "assets/images/icons/ipdb-favicon.png";
const PINTIPS_ICON_PATH = "assets/images/icons/pintips-bulb.svg";
let gamesCanManage = false;
/** Club eras are a display convention, derived only from OPDB display metadata. */
function gameEraLabel(game) {
  return ({ reels: 'EM', lights: 'EM', alphanumeric: 'Solid State', dmd: 'Modern', lcd: 'Modern' })[
    String(game.display || '').trim().toLowerCase()] || '';
}

function gameMetadataLabel(game) {
  const date = String(game.releaseDate || game.manufactureDate || '');
  return [game.manufacturer, /^\d{4}/.test(date) ? date.slice(0, 4) : '', gameEraLabel(game)].filter(Boolean).join(' · ');
}

function shortClubLocation(address) {
  const value = String(address || '').trim();
  if (/\bhaines\b/i.test(value)) return 'Haines St';
  if (/\bbridge\b/i.test(value)) return 'Bridge St';
  return value || 'Club location';
}

function compactStintDate(value) {
  const iso = normalizeIsoDateOrEmpty(value);
  if (!iso) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = Number(iso.slice(5, 7));
  return month >= 1 && month <= 12 ? `${months[month - 1]} ${iso.slice(0, 4)}` : '';
}

function orderedClubStints(stints, atClub) {
  const rows = (Array.isArray(stints) ? stints : []).filter(s => s && typeof s === 'object');
  const today = todayIsoDate();
  // A single newest open stint can be current. Do not mark every missing end as Present.
  const candidates = atClub ? rows.filter(s => !hasNonemptyString(s.leftClubDate) &&
    (!normalizeIsoDateOrEmpty(s.joinedClubDate) || s.joinedClubDate <= today)) : [];
  candidates.sort((a, b) => String(b.joinedClubDate || '').localeCompare(String(a.joinedClubDate || '')));
  const current = candidates[0];
  return rows.map(stint => ({ stint, current: stint === current })).sort((a, b) =>
    Number(b.current) - Number(a.current) ||
    String(b.stint.joinedClubDate || b.stint.leftClubDate || '').localeCompare(String(a.stint.joinedClubDate || a.stint.leftClubDate || '')));
}

function profileText(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function gameProfileRpc(name, args) {
  const client = getPublicSupabaseClient();
  if (!client) throw new Error('Service unavailable');
  const result = await client.rpc(name, args);
  if (result.error) throw result.error;
  return typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
}

/** A gallery owns its DOM: other profile requests cannot reset its focus or selection. */
function createGameGallery(game) {
  const panel = document.createElement('div');
  panel.className = 'games-profile-panel games-profile-photos';
  const stage = document.createElement('div');
  const controls = document.createElement('div');
  controls.className = 'games-gallery-controls';
  const count = profileText('p', '', 'games-gallery-count');
  count.setAttribute('role', 'status');
  const thumbs = document.createElement('div');
  thumbs.className = 'games-gallery-thumbnails';
  thumbs.setAttribute('role', 'group');
  thumbs.setAttribute('aria-label', 'Choose a machine photo');
  let images = game.primaryImage ? [game.primaryImage] : [];
  let selected = 0, loaded = false, loading = false;
  const lightbox = document.createElement('dialog');
  lightbox.className = 'games-photo-lightbox';
  lightbox.setAttribute('aria-label', `${game.title} photo viewer`);
  const fullStage = document.createElement('div');
  const close = profileText('button', 'Close photo'); close.type = 'button';
  close.addEventListener('click', () => lightbox.close());
  lightbox.append(close, fullStage);
  panel.append(stage, count, controls, thumbs, lightbox);
  const previous = profileText('button', 'Previous photo'); previous.type = 'button';
  const next = profileText('button', 'Next photo'); next.type = 'button';
  const enlarge = profileText('button', 'Enlarge photo'); enlarge.type = 'button';
  controls.append(previous, next, enlarge);
  const move = delta => { selected = (selected + delta + images.length) % images.length; paint(); };
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  enlarge.addEventListener('click', () => { paintFull(); lightbox.showModal(); });
  lightbox.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' && images.length > 1) { event.preventDefault(); move(-1); }
    if (event.key === 'ArrowRight' && images.length > 1) { event.preventDefault(); move(1); }
  });
  const fullControls = document.createElement('div'); fullControls.className = 'games-gallery-controls';
  for (const [label, delta] of [['Previous photo', -1], ['Next photo', 1]]) {
    const button = profileText('button', label); button.type = 'button';
    button.addEventListener('click', () => move(delta)); fullControls.appendChild(button);
  }
  lightbox.appendChild(fullControls);
  function paintFull() {
    fullStage.replaceChildren();
    if (images[selected]) {
      fullStage.appendChild(createGameImageFigure({ title: game.title, primaryImage: images[selected] }, true));
      const position = profileText('p', `Photo ${selected + 1} of ${images.length}`);
      position.setAttribute('role', 'status'); fullStage.appendChild(position);
    }
    fullControls.hidden = images.length < 2;
  }
  function paint() {
    stage.replaceChildren();
    const image = images[selected];
    if (image) stage.appendChild(createGameImageFigure({ title: game.title, primaryImage: image }, true));
    else stage.appendChild(profileText('p', 'No approved photos are available for this machine yet.'));
    count.textContent = image ? `Photo ${selected + 1} of ${images.length}` : '';
    controls.hidden = !image;
    previous.hidden = next.hidden = images.length < 2;
    // Keep the thumbnail buttons in place while selecting, preserving keyboard focus.
    Array.from(thumbs.children).forEach((button, index) => button.setAttribute('aria-pressed', String(index === selected)));
    if (lightbox.open) paintFull();
  }
  function paintThumbs() {
    thumbs.replaceChildren();
    thumbs.hidden = images.length < 2;
    if (images.length < 2) return;
    images.forEach((image, index) => {
      const button = document.createElement('button'); button.type = 'button';
      button.setAttribute('aria-label', `Show photo ${index + 1}: ${image.altText || game.title}`);
      const thumbnail = document.createElement('img');
      const variants = window.SNHGameImages.variants(image);
      thumbnail.src = variants[0]?.url || image.url;
      thumbnail.alt = ''; thumbnail.width = 80; thumbnail.height = 64;
      thumbnail.loading = 'lazy'; thumbnail.decoding = 'async';
      button.appendChild(thumbnail);
      button.addEventListener('click', () => { selected = index; paint(); });
      thumbs.appendChild(button);
    });
  }
  const status = profileText('p', '', 'games-gallery-status'); status.setAttribute('role', 'status');
  const retry = profileText('button', 'Retry photos'); retry.type = 'button'; retry.hidden = true;
  retry.addEventListener('click', () => void load()); panel.append(status, retry);
  async function load() {
    if (loaded || loading || !gameHasCatalogUuid(game) || !getPublicSupabaseClient()) return;
    loading = true; retry.hidden = true; status.textContent = 'Loading photos…';
    try {
      const rows = await gameProfileRpc('snh_public_game_images', { p_game_id: game.id });
      if (!panel.isConnected) return;
      images = Array.isArray(rows) ? rows.filter(image => image && image.url) : [];
      selected = 0; loaded = true; paintThumbs(); paint(); status.textContent = '';
    } catch {
      if (!panel.isConnected) return;
      status.textContent = 'Additional photos could not be loaded. The primary photo is shown when available.';
      retry.hidden = false;
    } finally { loading = false; }
  }
  paintThumbs(); paint();
  return { panel, load };
}

function createGameIssues(game) {
  const panel = document.createElement('div'); panel.className = 'games-profile-panel games-profile-issues';
  const summary = document.createElement('div');
  const member = document.createElement('div');
  panel.append(summary, member);
  let loaded = false, loading = false;
  const args = { p_game_id: game.id };
  function retrySummary(message) {
    summary.replaceChildren(profileText('p', message));
    const retry = profileText('button', 'Retry issues'); retry.type = 'button';
    retry.addEventListener('click', () => {
      summary.replaceChildren(profileText('p', 'Loading known issues…'));
      void showSummaries().catch(() => retrySummary('Known issues could not be loaded.'));
    }); summary.appendChild(retry);
  }
  async function showSummaries() {
    const rows = await gameProfileRpc('snh_public_game_issues', args);
    if (!panel.isConnected) return;
    summary.replaceChildren(profileText('h4', 'Known issues'));
    if (!Array.isArray(rows) || !rows.length) {
      summary.appendChild(profileText('p', 'No public issue summaries have been posted for this machine.'));
      return;
    }
    const list = document.createElement('ul');
    rows.forEach(row => list.appendChild(profileText('li', `${row.summary} · ${row.status === 'in_progress' ? 'In progress' : 'Reported'}`)));
    summary.appendChild(list);
  }
  async function load() {
    if (loaded || loading) return;
    loading = true; summary.replaceChildren(profileText('p', 'Loading known issues…')); member.replaceChildren();
    // Public summaries and authentication resolve independently; no private data is rendered here.
    const publicRead = gameHasCatalogUuid(game) && getPublicSupabaseClient()
      ? showSummaries().catch(() => retrySummary('Known issues could not be loaded.'))
      : Promise.resolve(summary.replaceChildren(profileText('p', 'Known issues are unavailable right now.')));
    try {
      const session = window.SNHSiteAuth ? await window.SNHSiteAuth.getSession() : null;
      if (!panel.isConnected) return;
      const portalHref = `members.html?panel=club-issues&issueGame=${encodeURIComponent(game.id)}`;
      if (!session?.user) {
        member.appendChild(profileText('p', 'Club members can report machine problems. Sign in or sign up to join the club.'));
        const signin = profileText('a', 'Sign in or sign up');
        signin.href = `signin.html?next=${encodeURIComponent(portalHref)}`;
        member.appendChild(signin);
      } else if (gameHasCatalogUuid(game)) {
        const manage = profileText('a', 'View member reports and manage issues'); manage.href = portalHref;
        member.append(profileText('p', 'Check existing member reports before adding another report.'), manage);
        const form = document.createElement('form'); form.className = 'games-issue-form';
        const titleLabel = profileText('label', 'Problem');
        const title = document.createElement('input'); title.required = true; title.maxLength = 160;
        titleLabel.appendChild(title);
        const bodyLabel = profileText('label', 'Details (optional)');
        const body = document.createElement('textarea'); body.rows = 4;
        bodyLabel.appendChild(body);
        const send = profileText('button', 'Report a problem'); send.type = 'submit';
        const status = profileText('p', 'Reports are shared with signed-in club members. A helper may publish a separate public summary.');
        status.setAttribute('role', 'status');
        form.append(titleLabel, bodyLabel, send, status);
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (send.disabled) return;
          const subject = title.value.trim();
          if (!subject) { title.focus(); return; }
          send.disabled = true; status.textContent = 'Submitting report…';
          try {
            // Existing server RPC enforces sign-in and forces ordinary members to Incoming.
            await gameProfileRpc('snh_club_issues_upsert', { p_id: null, p_fields: {
              gameId: game.id, title: subject, body: body.value.trim() || null, status: 'open'
            } });
            form.reset(); status.textContent = 'Report submitted. Thank you for helping care for this machine.';
          } catch { status.textContent = 'The report could not be confirmed. Check member reports before retrying, and sign in again if needed.'; }
          finally { send.disabled = false; }
        });
        member.appendChild(form);
      }
      loaded = true;
    } catch {
      member.appendChild(profileText('p', 'Sign-in status could not be checked. Open Member Tools to report a problem.'));
      const link = profileText('a', 'Open Member Tools'); link.href = `members.html?panel=club-issues&issueGame=${encodeURIComponent(game.id)}`; member.appendChild(link);
    } finally { await publicRead; loading = false; }
  }
  return { panel, load };
}


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
      variants: normalized.variants,
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

function createGameImageFigure(game, detail = false) {
  const selected = resolveGameImage(game);
  if (!selected) return null;

  const figure = document.createElement("figure");
  figure.className = "game-card-figure";
  const image = document.createElement("img");
  image.className = "game-card-image";
  window.SNHGameImages.apply(image, selected, detail);
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
function formatLocationStints(stints, atClub = false) {
  return orderedClubStints(stints, atClub).map(({ stint: s, current }) => {
    const from = compactStintDate(s.joinedClubDate);
    const through = compactStintDate(s.leftClubDate);
    const dates = current ? (from ? `${from} – Present` : 'Start unknown – Present')
      : from && through ? `${from} – ${through}`
      : from ? `${from} – End unknown` : through ? `Start unknown – ${through}` : 'Dates unknown';
    return `${shortClubLocation(s.address)} · ${dates}`;
  }).join('\n');
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
  gameId: "",
  onKeyDown: /** @type {((e: KeyboardEvent) => void) | null} */ (null),
  requestId: 0,
  background: [],
  previousOverflow: "",
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

  const header = document.createElement('div');
  header.className = 'games-profile-header';
  header.appendChild(titleEl);
  dialog.append(closeBtn, header);
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
    for (const row of [...pingolfTargets].sort((a, b) => Number(!!b?.isPreferred) - Number(!!a?.isPreferred))) {
      if (!row || typeof row !== "object") continue;
      const li = document.createElement("li");
      const t = hasNonemptyString(row.description) ? String(row.description) : "Target";
      if (row.isPreferred) {
        const label = document.createElement("strong");
        label.textContent = "★ Preferred: ";
        li.appendChild(label);
      }
      li.appendChild(document.createTextNode(t));
      if (row.targetType) {
        const type = document.createElement("small");
        type.textContent = ` · ${row.targetType}`;
        li.appendChild(type);
      }
      ul.appendChild(li);
    }
    addSection("Pingolf Targets", ul);
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
  gameMoreInfoUi.root?.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  gameMoreInfoUi.background.forEach(([node, inert]) => { node.inert = inert; });
  gameMoreInfoUi.background = [];
  document.body.style.overflow = gameMoreInfoUi.previousOverflow;
  gameMoreInfoUi.requestId += 1;
  if (gameMoreInfoUi.onKeyDown) {
    document.removeEventListener("keydown", gameMoreInfoUi.onKeyDown);
    gameMoreInfoUi.onKeyDown = null;
  }
  if (gameMoreInfoUi.root) {
    gameMoreInfoUi.root.hidden = true;
  }
  const returnFocus = gameMoreInfoUi.lastFocus?.isConnected
    ? gameMoreInfoUi.lastFocus : gameCardForId(gameMoreInfoUi.gameId)?.querySelector(".games-more-info-btn");
  if (returnFocus && typeof returnFocus.focus === "function") {
    returnFocus.focus();
  }
  gameMoreInfoUi.lastFocus = null;
}

function addGameProfileLink(row, label, url) {
  if (!hasNonemptyString(url)) return;
  const link = document.createElement("a");
  link.href = String(url);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const iconPath = ({ Kineticist: KINETICIST_ICON_PATH, Pinside: PINSIDE_ICON_PATH, IPDB: IPDB_ICON_PATH, OPDB: PINTIPS_ICON_PATH })[label];
  if (iconPath) {
    const icon = document.createElement('img'); icon.src = iconPath; icon.alt = ''; icon.className = 'games-provider-icon';
    link.append(icon, document.createTextNode(label));
    if (label === 'OPDB') { link.title = 'Game info on OPDB'; link.setAttribute('aria-label', 'Game info on OPDB'); }
  } else link.textContent = label;
  row.appendChild(link);
}

function renderGameTips(panel, tips, state, game) {
  const credit = document.createElement("p");
  credit.textContent = "Tips from PinTips";
  panel.appendChild(credit);
  const links = document.createElement("div");
  links.className = "games-profile-links";
  addGameProfileLink(links, "Game info on OPDB", getOpdbInfoUrl(game) || "https://app.matchplay.events/pintips");
  if (!tips.length) {
    const note = document.createElement("p");
    note.className = state === "error" ? "games-more-info-error" : "games-more-info-empty";
    note.textContent = state === "loading" ? "Loading tips…" : state === "error"
      ? "Tips could not be loaded. Please try again." : "No PinTips are available for this game yet.";
    panel.append(note, links);
    return;
  }
  const list = document.createElement("ul");
  list.className = "games-tips-list";
  tips.forEach(tip => {
    const item = document.createElement("li");
    const category = document.createElement("h4");
    category.textContent = String(tip.category || "Tip").replace(/_/g, " ");
    const text = document.createElement("p");
    text.className = "games-tip-text";
    text.textContent = tip.text;
    item.append(category, text);
    // The current official export has no contributor field. Never infer authorship.
    if (tip.contributor) {
      const author = document.createElement("p");
      author.className = "games-tip-credit";
      author.textContent = "By " + tip.contributor;
      item.appendChild(author);
    }
    list.appendChild(item);
  });
  panel.append(list, links);
}

function renderGameProfile(game, payload, error, tips = [], tipsState = "empty") {
  const body = gameMoreInfoUi.bodyEl;
  if (!body) return;
  body.replaceChildren();
  const tabs = document.createElement("div");
  tabs.className = "games-profile-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Game profile sections");
  const panels = [];
  function addTab(label, panel, onShow) {
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
    panels.push({ tab, panel, onShow });
    tab.addEventListener("click", () => activate(index));
    tab.addEventListener("keydown", (event) => {
      const next = event.key === "Home" ? 0 : event.key === "End" ? panels.length - 1
        : event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : null;
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
    if (panels[index]?.onShow) void panels[index].onShow();
  }

  const overview = document.createElement("div");
  overview.className = "games-profile-panel";
  const metadata = gameMetadataLabel(game);
  if (metadata) overview.appendChild(profileText('p', metadata, 'games-machine-metadata'));
  if (hasNonemptyString(game.details)) {
    const section = document.createElement("section");
    section.className = "games-more-info-section";
    const heading = document.createElement("h4");
    heading.textContent = "About our machine";
    const details = document.createElement("p");
    details.textContent = String(game.details);
    section.append(heading, details);
    overview.appendChild(section);
  }
  const stints = formatLocationStints(game.locationStints, game.atClub === true);
  if (stints) {
    const section = document.createElement("section");
    section.className = "games-more-info-section";
    const heading = document.createElement("h4");
    heading.textContent = "Location history";
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
  addGameProfileLink(links, "OPDB", getOpdbInfoUrl(game));
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

  const gallery = createGameGallery(game);
  addTab("Photos", gallery.panel, gallery.load);
  const play = document.createElement("div");
  play.className = "games-profile-panel";
  addTab("Play", play);
  const tipsPanel = document.createElement("div");
  tipsPanel.className = "games-profile-panel";
  renderGameTips(tipsPanel, tips, tipsState, game);
  addTab("Tips", tipsPanel);
  const issues = createGameIssues(game);
  addTab("Issues", issues.panel, issues.load);
  body.appendChild(tabs);
  panels.forEach(({ panel }) => body.appendChild(panel));
  activate(0);
  return { overview, play, tipsPanel, playTab: panels.find(p => p.panel === play) };
}

/** @param {{ title?: string, id?: string }} game */
async function openGameMoreInfoModal(game) {
  ensureGameMoreInfoModal();
  const root = gameMoreInfoUi.root;
  const titleEl = gameMoreInfoUi.titleEl;
  const dialog = gameMoreInfoUi.dialog;
  if (!root || !titleEl || !dialog) return;
  const requestId = ++gameMoreInfoUi.requestId;
  gameMoreInfoUi.gameId = String(game.id || "");
  gameMoreInfoUi.lastFocus = /** @type {HTMLElement} */ (document.activeElement);
  if (root.hidden) {
    gameMoreInfoUi.previousOverflow = document.body.style.overflow;
    gameMoreInfoUi.background = Array.from(document.body.children)
      .filter(node => node !== root).map(node => [node, node.inert]);
    gameMoreInfoUi.background.forEach(([node]) => { node.inert = true; });
    document.body.style.overflow = 'hidden';
  }
  root.hidden = false;
  titleEl.textContent = game.title ? `More about ${game.title}` : "Game details";
  const profile = renderGameProfile(game, null, false, [], getPublicSupabaseClient() && gameHasCatalogUuid(game) ? "loading" : "empty");
  gameMoreInfoUi.onKeyDown = (ev) => {
    if (root.querySelector('dialog[open]')) return;
    if (ev.key === 'Tab') {
      const focusable = Array.from(dialog.querySelectorAll('button, a[href], input, textarea, select, [tabindex="0"]'))
        .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (ev.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        ev.preventDefault(); last?.focus();
      } else if (!ev.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        ev.preventDefault(); first?.focus();
      }
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeGameMoreInfoModal();
    }
  };
  document.addEventListener("keydown", gameMoreInfoUi.onKeyDown);
  dialog.querySelector(".games-more-info-close")?.focus({ preventScroll: true });
  dialog.scrollTop = 0;

  const client = getPublicSupabaseClient();
  if (!client || !gameHasCatalogUuid(game)) {
    profile.play.appendChild(profileText('p', 'Club play information is unavailable right now.'));
    return;
  }
  // Independent panels update in place; a slow request never resets gallery, tabs or a report draft.
  const active = () => !root.hidden && requestId === gameMoreInfoUi.requestId;
  const loadInfo = async () => {
    try {
      const payload = await gameProfileRpc('snh_public_game_more_info', { p_game_id: game.id });
      if (!active()) return;
      profile.overview.querySelector('.games-info-status')?.remove();
      renderGameMoreInfoSections(payload, profile.overview, 'overview');
      profile.play.replaceChildren();
      if (!renderGameMoreInfoSections(payload, profile.play, 'play')) {
        profile.play.appendChild(profileText('p', 'No club high scores or Pingolf targets have been added for this machine yet.'));
      }
    } catch {
      if (!active()) return;
      const note = profileText('div', '', 'games-info-status');
      note.appendChild(profileText('p', 'Additional machine information could not be loaded.'));
      const retry = profileText('button', 'Retry machine information'); retry.type = 'button';
      retry.addEventListener('click', () => { note.remove(); void loadInfo(); }); note.appendChild(retry);
      profile.overview.appendChild(note);
      profile.play.replaceChildren(profileText('p', 'Club play information could not be loaded. Retry from Overview.'));
    }
  };
  const loadTips = async () => {
    try {
      const tips = await gameProfileRpc('snh_public_game_tips', { p_game_id: game.id });
      if (!active()) return;
      profile.tipsPanel.replaceChildren(); renderGameTips(profile.tipsPanel, Array.isArray(tips) ? tips : [], 'empty', game);
    } catch {
      if (!active()) return;
      profile.tipsPanel.replaceChildren(); renderGameTips(profile.tipsPanel, [], 'error', game);
      const retry = profileText('button', 'Retry tips'); retry.type = 'button';
      retry.addEventListener('click', () => void loadTips()); profile.tipsPanel.appendChild(retry);
    }
  };
  profile.play.appendChild(profileText('p', 'Loading club play information…'));
  await Promise.allSettled([loadInfo(), loadTips()]);
}

function createGamesList(games) {
  const list = document.createElement("ul");
  list.className = "games-list";

  for (const game of games) {
    const item = document.createElement("li");
    item.className = "games-list-item";
    if (game.id) item.dataset.gameId = String(game.id);
    const isAtClub = game && typeof game === "object" && game.atClub === true;
    if (isAtClub) {
      item.classList.add("games-list-item--at-club");
    }

    const heading = document.createElement("div");
    heading.className = "games-card-heading";
    const title = document.createElement("h3");
    title.textContent = game.title;
    heading.appendChild(title);
    const badge = document.createElement("span");
    badge.className = isAtClub ? "games-status-badge" : "games-status-badge games-status-badge--history";
    badge.textContent = isAtClub ? "At club" : "Club history";
    heading.appendChild(badge);
    item.appendChild(heading);

    const imageFigure = createGameImageFigure(game);
    if (imageFigure) {
      const image = imageFigure.querySelector(".game-card-image");
      if (image) {
        const imageButton = document.createElement("button");
        imageButton.type = "button";
        imageButton.className = "game-card-image-button";
        imageButton.setAttribute("aria-label", `View machine: ${game.title}`);
        imageButton.setAttribute("aria-haspopup", "dialog");
        imageButton.addEventListener("click", () => {
          void openGameMoreInfoModal(game);
        });
        image.replaceWith(imageButton);
        imageButton.appendChild(image);
      }
      item.appendChild(imageFigure);
    }

    const metadata = gameMetadataLabel(game);
    if (metadata) item.appendChild(profileText('p', metadata, 'games-machine-metadata'));
    const details = document.createElement("p");
    details.className = "games-details";
    const brief = String(game.details || '').trim();
    details.textContent = brief.length > 220 ? brief.slice(0, 217).replace(/\s+\S*$/, '') + '…' : brief;
    item.appendChild(details);

    const currentStint = orderedClubStints(game.locationStints, isAtClub).find(row => row.current)?.stint;
    if (currentStint) {
      const since = compactStintDate(currentStint.joinedClubDate);
      item.appendChild(profileText('p', `${shortClubLocation(currentStint.address)}${since ? ' · Since ' + since : ''}`, 'games-current-location'));
    }
    const stintsText = formatLocationStints(game.locationStints, game.atClub === true);
    if (stintsText) {
      const stintsEl = document.createElement("p");
      stintsEl.className = "games-location-stints";
      stintsEl.textContent = stintsText;
      const history = document.createElement("details");
      history.className = "games-history";
      const summary = document.createElement("summary");
      summary.textContent = "Location history";
      history.appendChild(summary);
      history.appendChild(stintsEl);
      item.appendChild(history);
    }

    const kineticistUrl = game.kineticistUrl;
    const pinsideUrl = game.pinsideUrl;
    const ipdbUrl = game.ipdbUrl;
    const pintipsUrl = getOpdbInfoUrl(game);
    const moreInfoEligible = true;
    const editHref = gamesCanManage ? gameEditorHref(game) : "";
    if (kineticistUrl || pinsideUrl || ipdbUrl || pintipsUrl || isAtClub || moreInfoEligible || editHref) {
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

      if (pintipsUrl) {
        const pintipsLink = document.createElement("a");
        pintipsLink.className = "games-provider-link games-pintips-link";
        pintipsLink.href = pintipsUrl;
        pintipsLink.target = "_blank";
        pintipsLink.rel = "noopener";
        pintipsLink.title = `View ${game.title} info on OPDB`;
        pintipsLink.setAttribute("aria-label", `View ${game.title} info on OPDB`);

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
        moreBtn.textContent = "View machine";
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
function getOpdbInfoUrl(game) {
  if (!game || typeof game !== "object") {
    return "";
  }
  if (!hasNonemptyString(game.opdbId)) {
    return "";
  }
  const opdbId = String(game.opdbId).trim();
  return `${MATCHPLAY_OPDB_ENTRY_BASE_URL}/${encodeURIComponent(opdbId)}`;
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

// Search narrows the selected timeline lineup; it never changes catalog data or sort order.
function filterGamesByQuery(games, query) {
  const terms = String(query || "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return games.filter(game => {
    const text = `${game.title || ""} ${game.details || ""}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

function renderGamesList(games) {
  const container = document.getElementById("games-list");
  const search = document.getElementById("games-search");
  const status = document.getElementById("games-search-status");
  const filtered = filterGamesByQuery(games, search ? search.value : "");
  if (status) status.textContent = `${filtered.length} of ${games.length} games in this lineup`;
  if (!container) return;
  if (!filtered.length) {
    showMessage(container, games.length ? "No matching games" : "No games on this date",
      games.length ? "Try a different title or description, or clear your search." : "Choose another date or show all games to explore the club’s history.");
    return;
  }
  container.replaceChildren(createGamesList(filtered));
}

function gameCardForId(id) {
  return Array.from(document.querySelectorAll("#games-list [data-game-id]"))
    .find(card => card.dataset.gameId === String(id));
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
    const linkedId = new URLSearchParams(window.location.search).get("game");
    const linkedGame = linkedId ? sorted.find(game => String(game.id) === linkedId) : null;
    let priorGames = [];
    let hasRenderedSnapshot = false;
    let showAllMode = new URLSearchParams(window.location.search).get("view") === "all";
    if (linkedGame && !isGameActiveOnDate(linkedGame, todayIso)) showAllMode = true;
    let currentLineup = [];
    function renderLineup(games) {
      currentLineup = games;
      renderGamesList(games);
    }
    const search = document.getElementById("games-search");
    if (linkedGame && search) search.value = "";
    if (search) search.addEventListener("input", () => renderGamesList(currentLineup));

    if (transitionBanner) {
      transitionBanner.hidden = hasAnyAtClub;
    }

    /**
     * @param {string} selectedIso
     * @param {boolean} fromCustomDate
     */
    function renderSnapshot(selectedIso, fromCustomDate) {
      if (showAllMode) {
        renderLineup(sorted);
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
      renderLineup(activeGames);

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

    if (linkedGame) {
      const card = gameCardForId(linkedId);
      card?.scrollIntoView({ block: "center" });
      const trigger = card?.querySelector(".games-more-info-btn");
      trigger?.focus({ preventScroll: true });
      void openGameMoreInfoModal(linkedGame);
    } else if (linkedId !== null) {
      const note = document.createElement("p");
      note.setAttribute("role", "status");
      note.textContent = "That game is unavailable. You can still browse the Games library below.";
      container.before(note);
    }

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

