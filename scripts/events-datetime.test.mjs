import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import data from '../assets/js/public-data.js';

process.env.TZ = 'America/New_York';
const source = await readFile(new URL('../assets/js/events.js', import.meta.url), 'utf8');
function element() {
  return { children: [], classList: { add() {} }, setAttribute() {},
    appendChild(child) { this.children.push(child); } };
}
const context = vm.createContext({ URL, document: {
  createElement: element, createTextNode: textContent => ({ textContent }),
} });
vm.runInContext(source.replace(/^loadEvents\(\);$|^void loadEventsPhotoSpotlight\(\);$/gm, ''), context);
const row = { id: '6c76d069-3d02-443f-8c33-3f0da3946609', title: 'League', starts_at: '2026-09-28T23:30:00Z' };
function text(node) { return (node.textContent || '') + (node.children || []).map(text).join(''); }

test('canonical timestamp survives live adapter and snapshot fallback and renders 7:30 PM', async () => {
  const event = data.eventFromRow(row);
  assert.equal(event.starts_at, row.starts_at);
  const snapshot = data.createSnapshot('events', [event]);
  const fallback = await data.load('events', { fetchImpl: async () => ({ ok: true, json: async () => snapshot }) });
  for (const item of [event, fallback.data[0]]) {
    const card = text(context.createEventCard({ ...item, time: 'obsolete value' }));
    assert.match(card, /Monday, September 28, 2026 · 7:30 PM/);
    assert.doesNotMatch(card, /Time not listed|obsolete value/);
  }
});

test('date and time agree with editor local conversion across UTC day and year boundaries', () => {
  const event = data.eventFromRow({ ...row, starts_at: '2027-01-01T01:30:00Z' });
  assert.match(text(context.createEventCard(event)), /Thursday, December 31, 2026 · 8:30 PM/);
  assert.equal(context.getPastEventsByYear([event])[0].year, '2026');
  assert.equal(context.eventTimeLabel({ starts_at: '2026-09-29T04:00:00Z' }), '12:00 AM');
});

test('date-only UTC placeholders, legacy snapshots, nulls and malformed times remain unknown', () => {
  for (const starts_at of ['2026-09-28T00:00:00Z', '2026-09-28T00:00:00.000+00:00', null, undefined, 'invalid', '2026-09-28']) {
    const event = { date: '2026-09-28', starts_at };
    assert.equal(context.eventTimeLabel(event), 'Time not listed');
    assert.match(text(context.createEventCard(event)), /Monday, September 28, 2026 · Time not listed/);
  }
  assert.match(text(context.createEventCard(data.eventFromRow({ ...row, starts_at: null }))), /Date to be announced · Time not listed/);
});
