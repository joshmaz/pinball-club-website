import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = new URL('../supabase/migrations/20261122225245_game_rotation_cabinets_and_loans.sql', import.meta.url);

test('private cabinet and loan foundation preserves catalog and lender identity', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema private;
      grant usage on schema private to anon, authenticated;

      create table public.games (id uuid primary key, slug text not null unique);
      create table public.owner_parties (id uuid primary key);
      insert into public.games values ('00000000-0000-0000-0000-000000000001', 'example');
      insert into public.owner_parties values
        ('00000000-0000-0000-0000-000000000002'),
        ('00000000-0000-0000-0000-000000000003');
    `);
    await db.exec(await readFile(migration, 'utf8'));

    const game = '00000000-0000-0000-0000-000000000001';
    const owner = '00000000-0000-0000-0000-000000000002';
    const lender = '00000000-0000-0000-0000-000000000003';
    const { rows: [first, second] } = await db.query(
      `insert into private.game_cabinets (game_id, label, owner_party_id)
       values ($1, 'Cabinet A', $2), ($1, 'Cabinet B', null) returning id`,
      [game, owner],
    );
    assert.notEqual(first.id, second.id);

    const openLoan = 'insert into private.game_loans (cabinet_id, lender_party_id) values ($1, $2) returning id';
    const { rows: [initial] } = await db.query(openLoan, [first.id, lender]);
    await assert.rejects(db.query(openLoan, [first.id, lender]), { code: '23505' });
    await db.query('update private.game_loans set closed_at = now() where id = $1', [initial.id]);
    const { rows: [renewed] } = await db.query(openLoan, [first.id, lender]);
    assert.notEqual(initial.id, renewed.id);

    await assert.rejects(
      db.query('update private.game_loans set returned_on = current_date where id = $1', [renewed.id]),
      { code: '23514' },
    );
    await assert.rejects(
      db.query('delete from public.owner_parties where id = $1', [lender]),
      error => ['23001', '23503'].includes(error.code),
    );
    await db.query('delete from public.owner_parties where id = $1', [owner]);
    const { rows: [cabinet] } = await db.query('select owner_party_id from private.game_cabinets where id = $1', [first.id]);
    assert.equal(cabinet.owner_party_id, null);

    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from private.game_cabinets'), { code: '42501' });
      await assert.rejects(db.query('select * from private.game_loans'), { code: '42501' });
      await db.exec('reset role');
    }
  } finally {
    await db.close();
  }
});
