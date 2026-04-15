// Loads event data and renders event cards into #events-container.
// If loading fails, an on-page error message is shown with debug details.
const EVENTS_URL = 'data/events.json';

function showMessage(container, title, details) {
  container.innerHTML = `
    <div class="event-card">
      <h3>${title}</h3>
      <p>${details}</p>
    </div>
  `;
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

    if (events.length === 0) {
      showMessage(container, 'No events yet', 'Check back soon for upcoming events.');
      return;
    }

    container.innerHTML = '';

    events.forEach((event) => {
      const div = document.createElement('div');
      div.className = 'event-card';

      div.innerHTML = `
        <h3>${event.title || event.name || 'Untitled Event'}</h3>
        <p><strong>Date:</strong> ${event.date || 'TBD'}</p>
        <p><strong>Location:</strong> ${event.location || 'TBD'}</p>
        <p>${event.description || ''}</p>
      `;

      container.appendChild(div);
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