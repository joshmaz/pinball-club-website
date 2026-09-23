// Loads event data and renders event cards into #events-container.
// Upcoming (today onward) events are shown first; past events open when a year is selected.
// If loading fails, an on-page error message is shown with debug details.
let eventsCanManage = false;

async function currentUserCanManageEvents() {
  if (!window.SNHSiteAuth) return false;
  try {
    const session = await window.SNHSiteAuth.getSession();
    if (!session || !session.user) return false;
    const roles = await window.SNHSiteAuth.fetchMemberRoles(session.user.id);
    return window.SNHSiteAuth.can(roles, 'events.manage');
  } catch (error) {
    console.warn('[SNH] Could not resolve Events edit access:', error);
    return false;
  }
}

function eventEditorHref(event) {
  const id = event && event.id != null ? String(event.id).trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return '';
  }
  return `members.html?panel=events&event=${encodeURIComponent(id)}`;
}

function showMessage(container, title, details) {
  container.replaceChildren();
  const card = document.createElement('div');
  card.className = 'event-card';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  const p = document.createElement('p');
  p.textContent = details;
  card.appendChild(h3);
  card.appendChild(p);
  container.appendChild(card);
}

function setDataSourceNote(container, result, allowed) {
  if (!container) return;
  let note = document.getElementById('events-data-source-note');
  if (!note) {
    note = document.createElement('p');
    note.id = 'events-data-source-note';
    note.className = 'events-data-source-note';
    container.parentNode.insertBefore(note, container);
  }
  note.hidden = !allowed;
  if (allowed) note.textContent = window.SNHPublicData.sourceLabel(result);
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** @returns {Date | null} start of that calendar day in local time, or null if unknown */
function parseEventDate(dateStr) {
  if (!dateStr || String(dateStr).trim() === '' || String(dateStr).trim().toUpperCase() === 'TBD') {
    return null;
  }
  const s = String(dateStr).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    return new Date(y, m, day);
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Presentation-only adapter. Current data has one URL; future providers may supply
// externalLinks: [{ url, label? }]. No schema, write path, or fabricated links.
function eventPresentationLinks(event) {
  const candidates = [...(Array.isArray(event.externalLinks) ? event.externalLinks : []), { url: event.url }];
  const seen = new Set();
  return candidates.flatMap((item) => {
    try {
      const url = new URL(String(item?.url || ''));
      if (!['https:', 'http:'].includes(url.protocol) || seen.has(url.href)) return [];
      seen.add(url.href);
      const host = url.hostname.toLowerCase();
      const belongsTo = (domain) => host === domain || host.endsWith('.' + domain);
      const provider = belongsTo('matchplay.events') ? 'Match Play'
        : belongsTo('facebook.com') || belongsTo('fb.me') ? 'Facebook'
        : belongsTo('discord.com') || belongsTo('discord.gg') ? 'Discord' : 'Event details';
      return [{ url: url.href, label: String(item.label || provider) }];
    } catch { return []; }
  });
}

function createEventCard(event, options = {}) {
  const { isUpcoming = false } = options;
  const div = document.createElement('div');
  div.className = 'event-card';
  div.classList.add(isUpcoming ? 'event-card--upcoming' : 'event-card--past');

  const date = parseEventDate(event.date);
  const dateBlock = document.createElement('div');
  dateBlock.className = 'event-date-block';
  dateBlock.setAttribute('aria-hidden', 'true');
  for (const [className, value] of [
    ['event-date-month', date ? date.toLocaleDateString('en-US', { month: 'short' }) : 'Date'],
    ['event-date-day', date ? String(date.getDate()).padStart(2, '0') : 'TBD'],
    ['event-date-year', date ? String(date.getFullYear()) : 'To come'],
  ]) {
    const part = document.createElement('span');
    part.className = className;
    part.textContent = value;
    dateBlock.appendChild(part);
  }
  div.appendChild(dateBlock);
  const body = document.createElement('div');
  body.className = 'event-card-body';
  div.appendChild(body);

  const badge = document.createElement('p');
  badge.className = 'event-card-badge';
  badge.textContent = isUpcoming ? 'Upcoming' : 'Past event';
  body.appendChild(badge);
  const h3 = document.createElement('h3');
  h3.textContent = event.title || event.name || 'Untitled Event';
  body.appendChild(h3);

  const dateP = document.createElement('p');
  dateP.className = 'event-card-meta';
  const time = document.createElement('time');
  if (date) time.setAttribute('datetime', String(event.date));
  time.textContent = date
    ? date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : 'Date to be announced';
  dateP.appendChild(time);
  // Public data currently supplies a calendar date, not a reliable start time.
  // Preserve any explicit presentation time; never infer midnight as a start time.
  dateP.appendChild(document.createTextNode(` · ${event.time || 'Time not listed'}`));
  body.appendChild(dateP);

  const locP = document.createElement('p');
  locP.className = 'event-card-location';
  const locStrong = document.createElement('strong');
  locStrong.textContent = 'Location: ';
  locP.appendChild(locStrong);
  locP.appendChild(document.createTextNode(String(event.location || 'TBD')));
  body.appendChild(locP);

  if (event.description != null && String(event.description).trim() !== '') {
    const descP = document.createElement('p');
    descP.className = 'event-card-description';
    descP.textContent = String(event.description);
    body.appendChild(descP);
  }

  const links = eventPresentationLinks(event);
  if (links.length) {
    const linkP = document.createElement('p');
    linkP.className = 'event-external-links';
    for (const item of links) {
      const link = document.createElement('a');
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = item.label + ' ↗';
      link.setAttribute('aria-label', `${item.label} for ${event.title || event.name || 'event'} (opens in a new tab)`);
      linkP.appendChild(link);
    }
    body.appendChild(linkP);
  }

  if (event.imageUrl != null && String(event.imageUrl).trim() !== '') {
    const img = document.createElement('img');
    img.src = String(event.imageUrl);
    img.alt = `${event.title || event.name || 'Event'} image`;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.className = 'event-card-image';
    body.appendChild(img);
  }

  const editHref = eventsCanManage ? eventEditorHref(event) : '';
  if (editHref) {
    const actions = document.createElement('p');
    actions.className = 'event-card-actions';
    const editLink = document.createElement('a');
    editLink.className = 'event-edit-link';
    editLink.href = editHref;
    editLink.textContent = 'Edit';
    editLink.setAttribute('aria-label', `Edit ${event.title || event.name || 'event'} in Member Tools`);
    actions.appendChild(editLink);
    body.appendChild(actions);
  }

  return div;
}

/**
 * @param {object[]} events
 * @returns {{ upcoming: object[], past: object[] }}
 */
function splitUpcomingAndPast(events) {
  const today = startOfToday();
  const upcoming = [];
  const past = [];

  for (const event of events) {
    const d = parseEventDate(event.date);
    if (d === null) {
      upcoming.push(event);
      continue;
    }
    if (d >= today) {
      upcoming.push(event);
    } else {
      past.push(event);
    }
  }

  const byDateAsc = (a, b) => {
    const da = parseEventDate(a.date);
    const db = parseEventDate(b.date);
    if (da && db) return da - db;
    if (da) return -1;
    if (db) return 1;
    return 0;
  };
  const byDateDesc = (a, b) => {
    const da = parseEventDate(a.date);
    const db = parseEventDate(b.date);
    if (da && db) return db - da;
    if (da) return -1;
    if (db) return 1;
    return 0;
  };

  upcoming.sort(byDateAsc);
  past.sort(byDateDesc);
  return { upcoming, past };
}

/**
 * Groups past events by year in descending order (newest year first).
 * Events with unknown dates are grouped under "Unknown".
 * @param {object[]} pastEvents
 * @returns {{ year: string, events: object[] }[]}
 */
function getPastEventsByYear(pastEvents) {
  const byYear = new Map();
  for (const event of pastEvents) {
    const d = parseEventDate(event.date);
    const year = d ? String(d.getFullYear()) : 'Unknown';
    if (!byYear.has(year)) {
      byYear.set(year, []);
    }
    byYear.get(year).push(event);
  }

  const sortedYears = [...byYear.keys()].sort((a, b) => {
    if (a === 'Unknown') return 1;
    if (b === 'Unknown') return -1;
    return Number(b) - Number(a);
  });

  const list = [];
  for (const year of sortedYears) {
    const events = byYear.get(year);
    const byDateDesc = (a, b) => {
      const da = parseEventDate(a.date);
      const db = parseEventDate(b.date);
      if (da && db) return db - da;
      if (da) return -1;
      if (db) return 1;
      return 0;
    };
    events.sort(byDateDesc);
    list.push({ year, events });
  }
  return list;
}

/**
 * Past events by year: only one year’s cards are in the DOM at a time.
 */
function renderPastEventsYearNavigator(region, pastByYearList) {
  if (pastByYearList.length === 0) {
    return;
  }

  let selectedIndex = null;

  const nav = document.createElement('div');
  nav.className = 'events-past-year-nav';
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'Browse past events by year');

  const btnLeft = document.createElement('button');
  btnLeft.type = 'button';
  btnLeft.className = 'events-past-year-arrow';
  btnLeft.setAttribute('aria-label', 'Show more recent year');
  btnLeft.textContent = '◀';

  const tabsWrap = document.createElement('div');
  tabsWrap.className = 'events-past-year-tabs';

  const btnRight = document.createElement('button');
  btnRight.type = 'button';
  btnRight.className = 'events-past-year-arrow';
  btnRight.setAttribute('aria-label', 'Show earlier year');
  btnRight.textContent = '▶';

  const panel = document.createElement('div');
  panel.className = 'events-past-year-panel';
  panel.setAttribute('aria-live', 'polite');

  const tabButtons = [];

  function renderYearCards() {
    panel.replaceChildren();
    panel.hidden = selectedIndex === null;

    if (selectedIndex !== null) {
      const { year, events } = pastByYearList[selectedIndex];
      const sub = document.createElement('h3');
      sub.className = 'events-past-current-year';
      sub.textContent = year;
      panel.appendChild(sub);

      const countP = document.createElement('p');
      countP.className = 'events-past-year-meta';
      countP.textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
      panel.appendChild(countP);

      for (const event of events) {
        panel.appendChild(createEventCard(event, { isUpcoming: false }));
      }
    }

    for (let i = 0; i < tabButtons.length; i++) {
      const pressed = i === selectedIndex;
      tabButtons[i].setAttribute('aria-pressed', String(pressed));
      tabButtons[i].classList.toggle('events-past-year-tab-selected', pressed);
      if (pressed) {
        const tabBounds = tabButtons[i].getBoundingClientRect();
        const wrapBounds = tabsWrap.getBoundingClientRect();
        if (tabBounds.left < wrapBounds.left) {
          tabsWrap.scrollBy({ left: tabBounds.left - wrapBounds.left, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        } else if (tabBounds.right > wrapBounds.right) {
          tabsWrap.scrollBy({ left: tabBounds.right - wrapBounds.right, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        }
      }
    }

    btnLeft.disabled = selectedIndex === null || selectedIndex <= 0;
    btnRight.disabled = selectedIndex === null || selectedIndex >= pastByYearList.length - 1;
  }

  for (let i = 0; i < pastByYearList.length; i++) {
    const { year, events } = pastByYearList[i];
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'events-past-year-tab';
    tab.textContent = year;
    tab.setAttribute('aria-pressed', 'false');
    tab.title = `${events.length} event${events.length === 1 ? '' : 's'} in ${year}`;
    tab.addEventListener('click', () => {
      selectedIndex = selectedIndex === i ? null : i;
      renderYearCards();
    });
    tabButtons.push(tab);
    tabsWrap.appendChild(tab);
  }

  btnLeft.addEventListener('click', () => {
    if (selectedIndex !== null && selectedIndex > 0) {
      selectedIndex -= 1;
      renderYearCards();
    }
  });

  btnRight.addEventListener('click', () => {
    if (selectedIndex !== null && selectedIndex < pastByYearList.length - 1) {
      selectedIndex += 1;
      renderYearCards();
    }
  });

  nav.appendChild(btnLeft);
  nav.appendChild(tabsWrap);
  nav.appendChild(btnRight);

  region.appendChild(nav);
  region.appendChild(panel);

  renderYearCards();
}

function renderEventsList(container, events) {
  container.innerHTML = '';
  if (events.length === 0) {
    showMessage(container, 'No events yet', 'Check back soon for upcoming events.');
    return;
  }

  const { upcoming, past } = splitUpcomingAndPast(events);

  const upcomingWrap = document.createElement('div');
  upcomingWrap.className = 'events-upcoming';
  container.appendChild(upcomingWrap);

  if (upcoming.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'events-empty-upcoming';
    empty.textContent = 'No upcoming events right now. Check back soon, or browse past events below.';
    upcomingWrap.appendChild(empty);
  } else {
    const upcomingHeading = document.createElement('h2');
    upcomingHeading.className = 'events-upcoming-heading';
    upcomingHeading.textContent = 'Upcoming events';
    upcomingWrap.appendChild(upcomingHeading);

    const upcomingMeta = document.createElement('p');
    upcomingMeta.className = 'events-upcoming-meta';
    upcomingMeta.textContent = `${upcoming.length} event${upcoming.length === 1 ? '' : 's'} coming up`;
    upcomingWrap.appendChild(upcomingMeta);

    for (const event of upcoming) {
      upcomingWrap.appendChild(createEventCard(event, { isUpcoming: true }));
    }
  }

  if (past.length === 0) {
    return;
  }

  const region = document.createElement('div');
  region.id = 'events-past-region';
  region.className = 'events-past-region';
  region.setAttribute('aria-label', 'Past events');

  const pastHeading = document.createElement('h2');
  pastHeading.className = 'events-past-heading';
  pastHeading.textContent = 'Past events';
  region.appendChild(pastHeading);

  const pastByYearList = getPastEventsByYear(past);
  renderPastEventsYearNavigator(region, pastByYearList);

  container.appendChild(region);
}

async function loadEvents() {
  const container = document.getElementById('events-container');

  if (!container) {
    console.error("Element with id 'events-container' not found.");
    return;
  }

  try {
    const result = await window.SNHPublicData.loadEvents();
    const events = result.data;
    setDataSourceNote(container, result, false);

    renderEventsList(container, events);
    void currentUserCanManageEvents().then((allowed) => {
      setDataSourceNote(container, result, allowed);
      if (allowed === eventsCanManage) return;
      eventsCanManage = allowed;
      renderEventsList(container, events);
    });
  } catch (error) {
    console.error('Error loading events:', error);
    showMessage(
      container,
      'Unable to load events',
      `We could not load the events list right now. Details: ${error.message}`
    );
  }
}

loadEvents();

const EVENTS_SPOTLIGHT_MAX_GRID = 6;

function eventsSpotlightNormalizeUuid(value) {
  if (!value || typeof value !== 'string') return '';
  const t = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(t)
  ) {
    return '';
  }
  return t;
}

function eventsSpotlightParseRpcJson(data) {
  if (data == null) return null;
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (_e) {
      return null;
    }
  }
  return data;
}

function eventsSpotlightBuildPublicPhotoUrl(objectKey) {
  const cfg = window.SNH_CONFIG || {};
  const supabaseUrl = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
  if (!supabaseUrl || !objectKey) return '';
  const encoded = String(objectKey)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${supabaseUrl}/storage/v1/object/public/photos-public/${encoded}`;
}

function eventsSpotlightPickVariant(asset, name) {
  const variants = (asset && asset.variants) || [];
  for (let i = 0; i < variants.length; i += 1) {
    if (variants[i] && variants[i].variant === name) return variants[i];
  }
  return null;
}

function eventsSpotlightAssetImageUrls(asset) {
  if (!asset) return { thumb: '', full: '' };
  const web = eventsSpotlightPickVariant(asset, 'web');
  const thumb = eventsSpotlightPickVariant(asset, 'thumb') || web;
  const fullSrc = web && web.objectKey ? eventsSpotlightBuildPublicPhotoUrl(web.objectKey) : '';
  const thumbSrc =
    thumb && thumb.objectKey ? eventsSpotlightBuildPublicPhotoUrl(thumb.objectKey) : fullSrc;
  return { thumb: thumbSrc || '', full: fullSrc || thumbSrc || '' };
}

function eventsSpotlightPromoImageUrls(promo) {
  if (!promo || !Array.isArray(promo.variants)) return { thumb: '', full: '' };
  const web = promo.variants.find((v) => v && v.variant === 'web');
  const thumb = promo.variants.find((v) => v && v.variant === 'thumb') || web;
  const fullSrc = web && web.objectKey ? eventsSpotlightBuildPublicPhotoUrl(web.objectKey) : '';
  const thumbSrc =
    thumb && thumb.objectKey ? eventsSpotlightBuildPublicPhotoUrl(thumb.objectKey) : fullSrc;
  return { thumb: thumbSrc || '', full: fullSrc || thumbSrc || '' };
}

function eventsSpotlightClearShell(section, statusEl, logoEl, titleEl, descEl, gridEl) {
  if (statusEl) statusEl.textContent = '';
  if (titleEl) titleEl.textContent = '';
  if (descEl) {
    descEl.textContent = '';
    descEl.hidden = true;
  }
  if (gridEl) gridEl.replaceChildren();
  if (logoEl) {
    logoEl.removeAttribute('src');
    logoEl.removeAttribute('srcset');
    logoEl.hidden = true;
  }
  if (section) section.hidden = true;
}

async function loadEventsPhotoSpotlight() {
  const section = document.getElementById('events-photo-spotlight');
  const statusEl = document.getElementById('events-photo-spotlight-status');
  const logoEl = document.getElementById('events-photo-spotlight-logo');
  const titleEl = document.getElementById('events-photo-spotlight-title');
  const descEl = document.getElementById('events-photo-spotlight-desc');
  const gridEl = document.getElementById('events-photo-spotlight-grid');
  if (!section || !logoEl || !titleEl || !descEl || !gridEl) return;

  const client = window.snhSupabase;
  if (!client || typeof client.rpc !== 'function') {
    eventsSpotlightClearShell(section, statusEl, logoEl, titleEl, descEl, gridEl);
    return;
  }

  try {
    const albumRes = await client.rpc('snh_public_events_spotlight_album');
    if (albumRes.error) throw albumRes.error;
    const album = eventsSpotlightParseRpcJson(albumRes.data);
    if (!album || typeof album !== 'object') {
      eventsSpotlightClearShell(section, statusEl, logoEl, titleEl, descEl, gridEl);
      return;
    }

    let promo = null;
    const evId = album.eventId != null ? String(album.eventId).trim() : '';
    if (evId && eventsSpotlightNormalizeUuid(evId)) {
      const promoRes = await client.rpc('snh_public_event_promo_asset', { p_event_id: evId });
      if (!promoRes.error) {
        promo = eventsSpotlightParseRpcJson(promoRes.data);
      }
    }

    const assets = Array.isArray(album.assets) ? album.assets : [];
    let heroAssetId = promo && promo.assetId != null ? String(promo.assetId) : '';

    const { thumb: promoThumb, full: promoFull } = eventsSpotlightPromoImageUrls(promo);
    let logoThumb = promoThumb;
    let logoFull = promoFull;
    let logoAlt = (promo && (promo.altText || promo.caption)) || '';

    if (!logoThumb && assets.length > 0) {
      const first = assets[0];
      heroAssetId = String(first.id || '');
      const u = eventsSpotlightAssetImageUrls(first);
      logoThumb = u.thumb;
      logoFull = u.full;
      logoAlt = first.altText || first.caption || album.title || 'Event photo';
    }

    if (logoThumb) {
      logoEl.src = logoThumb;
      logoEl.srcset = logoFull && logoFull !== logoThumb ? `${logoThumb} 1x, ${logoFull} 2x` : '';
      logoEl.alt = logoAlt || album.title || 'Featured event photo';
      logoEl.hidden = false;
    } else {
      logoEl.removeAttribute('srcset');
      logoEl.hidden = true;
    }

    titleEl.textContent = album.title || 'Photo album';
    const descText = album.description != null ? String(album.description).trim() : '';
    if (descText) {
      descEl.textContent = descText;
      descEl.hidden = false;
    } else {
      descEl.textContent = '';
      descEl.hidden = true;
    }

    const gridAssets = [];
    for (let i = 0; i < assets.length && gridAssets.length < EVENTS_SPOTLIGHT_MAX_GRID; i += 1) {
      const asset = assets[i];
      if (!asset) continue;
      if (heroAssetId && String(asset.id) === heroAssetId) continue;
      const { thumb, full } = eventsSpotlightAssetImageUrls(asset);
      if (!thumb) continue;
      gridAssets.push({ asset, thumb, full });
    }

    gridEl.replaceChildren();
    const gridLabel = `${album.title || 'Event'} photos`;
    gridEl.setAttribute('aria-label', gridLabel);
    section.setAttribute('aria-label', gridLabel);

    for (let j = 0; j < gridAssets.length; j += 1) {
      const { asset, thumb, full } = gridAssets[j];
      const fig = document.createElement('figure');
      fig.className = 'event-spotlight-card';
      fig.setAttribute('role', 'listitem');
      const img = document.createElement('img');
      img.src = thumb;
      if (full && full !== thumb) {
        img.srcset = `${thumb} 1x, ${full} 2x`;
      }
      img.alt = asset.altText || asset.caption || album.title || 'Event photo';
      img.loading = 'lazy';
      img.decoding = 'async';
      fig.appendChild(img);
      gridEl.appendChild(fig);
    }

    if (statusEl) statusEl.textContent = '';
    section.hidden = false;
  } catch (err) {
    console.warn('[SNH] Events photo spotlight:', err);
    section.hidden = false;
    if (statusEl) {
      statusEl.textContent = `Could not load featured photos: ${err && err.message ? err.message : String(err)}`;
    }
  }
}

void loadEventsPhotoSpotlight();
