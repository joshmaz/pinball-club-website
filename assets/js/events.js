// This script fetches event data from '/assets/data/events.json' and dynamically creates event cards in the element with id 'events-container'.
// Expected structure of events.json:
// [
//   {
//     "title": "Event Title",
//     "date": "YYYY-MM-DD",
//     "location": "Event Location",
//     "description": "Event Description"
//   },
//   ...
// ]

fetch('data/events.json')
  .then(response => response.json())
  .then(events => {
    const container = document.getElementById('events-container');

    if (!container) {
      console.error("Element with id 'events-container' not found.");
      return;
    }

    events.forEach(event => {
      const div = document.createElement('div');
      div.className = 'event-card';

      div.innerHTML = `
        <h3>${event.title || event.name || "Untitled Event"}</h3>
        <p><strong>Date:</strong> ${event.date}</p>
        <p><strong>Location:</strong> ${event.location}</p>
        <p>${event.description}</p>
      `;

      container.appendChild(div);
    });
  })
  .catch(err => console.error('Error loading events:', err));