import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalStart, importedStart } from './event-start.mjs';
test('imports preserve full start timestamps across offsets and UTC date boundaries', () => {
  assert.equal(importedStart({ starts_at: '2026-09-28T19:30:00-04:00' }, '2026-09-28'), '2026-09-28T23:30:00.000Z');
  assert.equal(importedStart({ starts_at: '2026-01-05T19:30:00-05:00' }, '2026-01-05'), '2026-01-06T00:30:00.000Z');
  assert.equal(importedStart({}, '2026-09-28'), '2026-09-28T00:00:00Z');
  assert.equal(importedStart({}, ''), null);
});
test('imports refuse malformed or timezone-free timestamps instead of losing times silently', () => {
  for (const value of ['bad', '2026-09-28', '2026-09-28T19:30', '2026-13-28T19:30Z']) {
    assert.throws(() => canonicalStart(value));
  }
});
