// Loads event data and renders event cards into #events-container.
// Upcoming (today onward) events are shown first; past events stay behind a toggle.
// If loading fails, an on-page error message is shown with debug details.
const EVENTS_URL = 'data/events.json';

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

function createEventCard(event) {
  const div = document.createElement('div');
  div.className = 'event-card';

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
    for (const event of upcoming) {
      upcomingWrap.appendChild(createEventCard(event));
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

  for (const event of past) {
    region.appendChild(createEventCard(event));
  }

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
    const response = await fetch(EVENTS_URL, { cache: 'no-store' });

    if (!response.ok) {
      throw new Error(`Request failed (${response.status} ${response.statusText}) for ${EVENTS_URL}`);
    }

    const events = await response.json();

    if (!Array.isArray(events)) {
      throw new Error(`Invalid data format in ${EVENTS_URL}: expected an array.`);
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