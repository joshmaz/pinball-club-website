#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FB_EVENTS_URL = 'https://www.facebook.com/snhpinball/events';
const DATA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'events.json'
);

function extractLdJsonBlocks(html) {
  const blocks = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = regex.exec(html);
  while (match) {
    blocks.push(match[1]);
    match = regex.exec(html);
  }
  return blocks;
}

function walkForEvents(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) walkForEvents(item, out);
    return;
  }
  if (!node || typeof node !== 'object') {
    return;
  }

  const type = node['@type'];
  const isEvent = Array.isArray(type) ? type.includes('Event') : type === 'Event';
  if (isEvent) {
    out.push(node);
  }

  for (const value of Object.values(node)) {
    walkForEvents(value, out);
  }
}

function normalizeDate(startDate) {
  if (!startDate) return 'TBD';
  const d = new Date(startDate);
  if (Number.isNaN(d.getTime())) {
    return String(startDate);
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeLocation(raw) {
  if (!raw) return 'TBD';
  if (typeof raw === 'string') return raw;
  if (typeof raw !== 'object') return 'TBD';

  const place = raw.name;
  const addr = raw.address;
  if (typeof addr === 'string') {
    return place ? `${place} - ${addr}` : addr;
  }
  if (addr && typeof addr === 'object') {
    const parts = [
      addr.streetAddress,
      addr.addressLocality,
      addr.addressRegion,
      addr.postalCode
    ].filter(Boolean);
    if (parts.length > 0) {
      return place ? `${place} - ${parts.join(', ')}` : parts.join(', ');
    }
  }
  return place || 'TBD';
}

function normalizeEvent(evt) {
  return {
    name: evt.name || 'Untitled Event',
    date: normalizeDate(evt.startDate),
    location: normalizeLocation(evt.location),
    description: evt.description || '',
    url: evt.url || '',
    source: 'facebook'
  };
}

function dedupeByNameAndDate(events) {
  const seen = new Set();
  const out = [];
  for (const evt of events) {
    const key = `${evt.name}__${evt.date}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(evt);
  }
  return out;
}

async function loadExistingEvents() {
  try {
    const raw = await readFile(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function main() {
  console.log(`Fetching ${FB_EVENTS_URL}...`);
  const response = await fetch(FB_EVENTS_URL, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept: 'text/html'
    }
  });

  if (!response.ok) {
    throw new Error(`Facebook request failed (${response.status} ${response.statusText})`);
  }

  const html = await response.text();
  const blocks = extractLdJsonBlocks(html);
  const discovered = [];

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      walkForEvents(parsed, discovered);
    } catch {
      // Ignore non-JSON-LD script blocks.
    }
  }

  const syncedEvents = dedupeByNameAndDate(discovered.map(normalizeEvent));
  if (syncedEvents.length === 0) {
    throw new Error(
      'No Facebook events were detected. Facebook may require login or may have changed page markup.'
    );
  }

  const existingEvents = await loadExistingEvents();
  const nonFacebookEvents = existingEvents.filter((evt) => evt.source !== 'facebook');
  const mergedEvents = [...nonFacebookEvents, ...syncedEvents];

  await writeFile(DATA_PATH, `${JSON.stringify(mergedEvents, null, 2)}\n`, 'utf8');
  console.log(
    `Saved ${syncedEvents.length} Facebook event(s) to ${DATA_PATH} (${nonFacebookEvents.length} non-Facebook event(s) preserved).`
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
