// Loads event data and renders event cards into #events-container.
// Upcoming (today onward) events are shown first; past events stay behind a toggle.
// If loading fails, an on-page error message is shown with debug details.
const EVENTS_URL = 'data/events.json';
const EVENTS_TABLE = 'events';

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

function setDataSourceNote(container, source, detail = '') {
  if (!container) return;
  let note = document.getElementById('events-data-source-note');
  if (!note) {
    note = document.createElement('p');
    note.id = 'events-data-source-note';
    note.className = 'events-data-source-note';
    container.parentNode.insertBefore(note, container);
  }
  if (source === 'supabase') {
    note.textContent = 'Data source: Supabase';
    return;
  }
  note.textContent = detail
    ? `Data source: JSON fallback (${detail})`
    : 'Data source: JSON fallback';
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

function createEventCard(event, options = {}) {
  const { isUpcoming = false } = options;
  const div = document.createElement('div');
  div.className = 'event-card';
  div.classList.add(isUpcoming ? 'event-card--upcoming' : 'event-card--past');

  if (isUpcoming) {
    const badge = document.createElement('p');
    badge.className = 'event-card-badge';
    badge.textContent = 'Upcoming';
    div.appendChild(badge);
  }

  const imageUrl = event.imageUrl;
  if (imageUrl != null && String(imageUrl).trim() !== '') {
    const img = document.createElement('img');
    img.src = String(imageUrl);
    img.alt = `${event.title || event.name || 'Event'} image`;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.style.width = '100%';
    img.style.height = 'auto';
    img.style.borderRadius = '8px';
    img.style.marginBottom = '0.75rem';
    div.appendChild(img);
  }

  const h3 = document.createElement('h3');
  h3.textContent = event.title || event.name || 'Untitled Event';
  div.appendChild(h3);

  const dateP = document.createElement('p');
  const dateStrong = document.createElement('strong');
  dateStrong.textContent = 'Date: ';
  dateP.appendChild(dateStrong);
  dateP.appendChild(document.createTextNode(String(event.date || 'TBD')));
  div.appendChild(dateP);

  const locP = document.createElement('p');
  const locStrong = document.createElement('strong');
  locStrong.textContent = 'Location: ';
  locP.appendChild(locStrong);
  locP.appendChild(document.createTextNode(String(event.location || 'TBD')));
  div.appendChild(locP);

  const desc = event.description;
  if (desc != null && String(desc).trim() !== '') {
    const descP = document.createElement('p');
    descP.textContent = String(desc);
    div.appendChild(descP);
  }

  const eventUrl = event.url;
  if (eventUrl != null && String(eventUrl).trim() !== '') {
    const linkP = document.createElement('p');
    const link = document.createElement('a');
    link.href = String(eventUrl);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View event details';
    linkP.appendChild(link);
    div.appendChild(linkP);
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

function wirePastToggle(toggle, region) {
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    const next = !expanded;
    toggle.setAttribute('aria-expanded', String(next));
    toggle.textContent = next ? 'Hide past events' : 'Show past events';
    region.hidden = !next;
  });
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

  let selectedIndex = 0;

  const nav = document.createElement('div');
  nav.className = 'events-past-year-nav';
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'Browse past events by year');

  const btnLeft = document.createElement('button');
  btnLeft.type = 'button';
  btnLeft.className = 'events-past-year-arrow';
  btnLeft.setAttribute('aria-label', 'Show earlier years');
  btnLeft.textContent = '◀';

  const tabsWrap = document.createElement('div');
  tabsWrap.className = 'events-past-year-tabs';

  const btnRight = document.createElement('button');
  btnRight.type = 'button';
  btnRight.className = 'events-past-year-arrow';
  btnRight.setAttribute('aria-label', 'Show more recent years');
  btnRight.textContent = '▶';

  const panel = document.createElement('div');
  panel.className = 'events-past-year-panel';
  panel.setAttribute('aria-live', 'polite');

  const tabButtons = [];

  function renderYearCards() {
    const { year, events } = pastByYearList[selectedIndex];
    panel.replaceChildren();

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

    for (let i = 0; i < tabButtons.length; i++) {
      const pressed = i === selectedIndex;
      tabButtons[i].setAttribute('aria-pressed', String(pressed));
      tabButtons[i].classList.toggle('events-past-year-tab-selected', pressed);
      if (pressed) {
        tabButtons[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }

    btnLeft.disabled = selectedIndex <= 0;
    btnRight.disabled = selectedIndex >= pastByYearList.length - 1;
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
      selectedIndex = i;
      renderYearCards();
    });
    tabButtons.push(tab);
    tabsWrap.appendChild(tab);
  }

  btnLeft.addEventListener('click', () => {
    if (selectedIndex > 0) {
      selectedIndex -= 1;
      renderYearCards();
    }
  });

  btnRight.addEventListener('click', () => {
    if (selectedIndex < pastByYearList.length - 1) {
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

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'events-past-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = 'Show past events';

  const region = document.createElement('div');
  region.id = 'events-past-region';
  region.className = 'events-past-region';
  region.hidden = true;
  region.setAttribute('aria-label', 'Past events');
  toggle.setAttribute('aria-controls', region.id);

  const pastHeading = document.createElement('h2');
  pastHeading.className = 'events-past-heading';
  pastHeading.textContent = 'Past events';
  region.appendChild(pastHeading);

  const pastByYearList = getPastEventsByYear(past);
  renderPastEventsYearNavigator(region, pastByYearList);

  container.appendChild(toggle);
  container.appendChild(region);
  wirePastToggle(toggle, region);
}

async function loadEvents() {
  const container = document.getElementById('events-container');

  if (!container) {
    console.error("Element with id 'events-container' not found.");
    return;
  }

  try {
    let events = [];
    let usedSupabase = false;
    let fallbackReason = '';

    if (window.snhSupabase) {
      const { data, error } = await window.snhSupabase
        .from(EVENTS_TABLE)
        .select('title,description,location,starts_at,external_url,source')
        .or('published.eq.true,published.is.null')
        .order('starts_at', { ascending: true, nullsFirst: false });

      if (error) {
        fallbackReason = `Supabase query error: ${error.message}`;
        console.warn('[SNH] Could not load events from Supabase, falling back to JSON:', error.message);
      } else if (Array.isArray(data)) {
        usedSupabase = true;
        events = data.map((row) => {
          let date = 'TBD';
          if (row.starts_at) {
            const d = new Date(row.starts_at);
            if (!Number.isNaN(d.getTime())) {
              const y = d.getUTCFullYear();
              const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
              const day = String(d.getUTCDate()).padStart(2, '0');
              date = `${y}-${mo}-${day}`;
            }
          }
          return {
            title: row.title || 'Untitled Event',
            date,
            location: row.location || 'TBD',
            description: row.description || '',
            url: row.external_url || '',
            source: row.source || 'supabase',
          };
        });
        if (events.length === 0) {
          fallbackReason = 'Supabase returned 0 rows';
        }
      }
    } else if (window.snhSupabaseError === 'missing_config') {
      fallbackReason = 'Missing Supabase config';
    } else if (window.snhSupabaseError === 'missing_client') {
      fallbackReason = 'Supabase client failed to load';
    } else {
      fallbackReason = 'Supabase not initialized';
    }

    if (!usedSupabase || events.length === 0) {
      const response = await fetch(EVENTS_URL, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status} ${response.statusText}) for ${EVENTS_URL}`);
      }

      events = await response.json();
      if (!Array.isArray(events)) {
        throw new Error(`Invalid data format in ${EVENTS_URL}: expected an array.`);
      }
      if (!fallbackReason && window.location.protocol === 'file:') {
        fallbackReason = 'Opened via file:// (serve over http://localhost)';
      }
      setDataSourceNote(container, 'json', fallbackReason);
    } else {
      setDataSourceNote(container, 'supabase');
    }

    renderEventsList(container, events);
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

function eventsSpotlightConfig() {
  const cfg = window.SNH_CONFIG || {};
  const slug = cfg.eventsSpotlightAlbumSlug != null ? String(cfg.eventsSpotlightAlbumSlug).trim() : '';
  const eventId = cfg.eventsSpotlightEventId != null ? String(cfg.eventsSpotlightEventId).trim() : '';
  return { slug: slug.toLowerCase(), eventId };
}

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

function eventsSpotlightAlbumSortKey(album) {
  const sp = album && album.sortPosition;
  if (sp == null || Number.isNaN(Number(sp))) return 1e9;
  return Number(sp);
}

function eventsSpotlightPickAlbum(albums, cfg) {
  if (!Array.isArray(albums) || albums.length === 0) return null;
  if (cfg.slug) {
    for (let i = 0; i < albums.length; i += 1) {
      const a = albums[i];
      if (a && String(a.slug || '').toLowerCase() === cfg.slug) return a;
    }
  }
  const eid = eventsSpotlightNormalizeUuid(cfg.eventId);
  if (!eid) return null;
  const linked = albums.filter((a) => a && String(a.eventId || '').toLowerCase() === eid);
  if (linked.length === 0) return null;
  linked.sort((a, b) => {
    const d = eventsSpotlightAlbumSortKey(a) - eventsSpotlightAlbumSortKey(b);
    if (d !== 0) return d;
    return String(a.title || '').localeCompare(String(b.title || ''), undefined, {
      sensitivity: 'base',
    });
  });
  return linked[0];
}

async function loadEventsPhotoSpotlight() {
  const section = document.getElementById('events-photo-spotlight');
  const statusEl = document.getElementById('events-photo-spotlight-status');
  const logoEl = document.getElementById('events-photo-spotlight-logo');
  const titleEl = document.getElementById('events-photo-spotlight-title');
  const descEl = document.getElementById('events-photo-spotlight-desc');
  const gridEl = document.getElementById('events-photo-spotlight-grid');
  if (!section || !logoEl || !titleEl || !descEl || !gridEl) return;

  const cfg = eventsSpotlightConfig();
  if (!cfg.slug && !cfg.eventId) {
    return;
  }
  if (!cfg.slug && cfg.eventId && !eventsSpotlightNormalizeUuid(cfg.eventId)) {
    section.hidden = false;
    if (statusEl) {
      statusEl.textContent =
        'SNH_CONFIG.eventsSpotlightEventId is set but is not a valid UUID. Fix config.js or regenerate from EVENTS_SPOTLIGHT_EVENT_ID.';
    }
    return;
  }

  const client = window.snhSupabase;
  if (!client || typeof client.rpc !== 'function') {
    section.hidden = false;
    if (statusEl) {
      statusEl.textContent =
        'Featured photos need Supabase config. Run node scripts/write-config.mjs and deploy config.js.';
    }
    return;
  }

  try {
    const albumsRes = await client.rpc('snh_public_photo_albums');
    if (albumsRes.error) throw albumsRes.error;
    const albumsRaw = eventsSpotlightParseRpcJson(albumsRes.data);
    const albums = Array.isArray(albumsRaw) ? albumsRaw : [];
    const album = eventsSpotlightPickAlbum(albums, cfg);
    if (!album) {
      section.hidden = false;
      if (statusEl) {
        statusEl.textContent =
          cfg.slug !== ''
            ? `No published album matched slug “${cfg.slug}”.`
            : 'No published album is linked to that event yet.';
      }
      titleEl.textContent = '';
      descEl.textContent = '';
      gridEl.replaceChildren();
      logoEl.hidden = true;
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