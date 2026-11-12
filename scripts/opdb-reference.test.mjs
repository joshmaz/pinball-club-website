import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ipdbPermalink,
  normalizeOpdbArchive,
  readBoundedResponse,
} from '../supabase/functions/_shared/opdb-reference.mjs';

function archive() {
  const entries = [
    { opdbId: 'G48nw-M5RPZ', opdbGroup: 'G48nw', ipdbId: 2697, name: '2001', manufactureDate: '1971-02-01', manufacturer: { name: 'Gottlieb' } },
    { opdbId: 'GRoQ6-MLx0X', opdbGroup: 'GRoQ6', ipdbId: 469, name: 'Catacomb', manufactureDate: '1981-01-01', manufacturer: { name: 'Stern Electronics' } },
  ];
  for (let i = 0; i < 998; i++) {
    entries.push({
      opdbId: `Gsample${i}-Mmachine`,
      opdbGroup: `Gsample${i}`,
      ipdbId: i < 498 ? 10000 + i : null,
      name: `Sample ${i}`,
      manufactureDate: '1980-01-01',
      manufacturer: { name: 'Sample Manufacturer' },
    });
  }
  return { entries };
}

test('validated archive preserves exact OPDB to IPDB mappings and normalized source facts', () => {
  const result = normalizeOpdbArchive(archive());
  const game2001 = result.rows.find((row) => row.opdb_id === 'G48nw-M5RPZ');
  const catacomb = result.rows.find((row) => row.opdb_id === 'GRoQ6-MLx0X');
  assert.equal(result.entryCount, 1000);
  assert.equal(result.ipdbCount, 500);
  assert.equal(game2001.ipdb_id, 2697);
  assert.equal(game2001.manufacturer, 'Gottlieb');
  assert.equal(catacomb.ipdb_id, 469);
  assert.equal(ipdbPermalink(catacomb.ipdb_id), 'https://www.ipdb.org/machine.cgi?id=469');
  assert.equal(ipdbPermalink(null), null);
});

test('a damaged, duplicate, unexpectedly small, or regressed export is rejected', () => {
  assert.throws(() => normalizeOpdbArchive({ entries: [] }), /unexpected shape or record count/);
  const duplicate = archive();
  duplicate.entries[2] = { ...duplicate.entries[1] };
  assert.throws(() => normalizeOpdbArchive(duplicate), /invalid or duplicated/);
  const badGroup = archive();
  badGroup.entries[0] = { ...badGroup.entries[0], opdbGroup: 'Gwrong' };
  assert.throws(() => normalizeOpdbArchive(badGroup), /invalid or duplicated/);
  assert.throws(() => normalizeOpdbArchive(archive(), 3000), /unexpected shape or record count/);
});

test('bounded response rejects failed and oversized downloads', async () => {
  await assert.rejects(readBoundedResponse(new Response('bad', { status: 503 })), /HTTP 503/);
  await assert.rejects(readBoundedResponse(new Response('12345'), 4), /exceeds the safe download limit/);
});
