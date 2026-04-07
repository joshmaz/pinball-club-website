fetch('/assets/data/events.json')
  .then(response => response.json())
  .then(events => {
    const container = document.getElementById('events-container');

    events.forEach(event => {
      const div = document.createElement('div');
      div.className = 'event-card';

      div.innerHTML = `
        <h3>${event.title}</h3>
        <p><strong>Date:</strong> ${event.date}</p>
        <p><strong>Location:</strong> ${event.location}</p>
        <p>${event.description}</p>
      `;

      container.appendChild(div);
    });
  })
  .catch(err => console.error('Error loading events:', err));