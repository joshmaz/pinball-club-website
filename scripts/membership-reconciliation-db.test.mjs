import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('dues review is private, resumable, idempotent and bounded', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema private;
      create schema auth;
      create schema cron;
      create table cron.jobs(command text);
      create function cron.schedule(text,text,text) returns void language sql as $$ insert into cron.jobs values ($3) $$;
      create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
      create table members(id uuid primary key, user_id uuid, display_name text, first_name text, last_name text);
      create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
      create function snh_member_has_effective_role(text) returns boolean language sql as $$
        select current_setting('test.dues_role',true) = 'membership_admin' and $1 = 'membership_admin'
      $$;
      insert into auth.users values (auth.uid(), 'Member@example.test',now());
      insert into members values (auth.uid(),auth.uid(),'Example Member',null,null);
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/20261120200000_membership_reconciliation.sql', import.meta.url), 'utf8'));
    const query = async (sql, args) => (await db.query(sql, args)).rows;
    const rpc = async (args, params) => (await query('select snh_reconcile_dues(' + args + ') as data', params))[0].data;
    const email = 'payer@example.test';
    const yesterday = '(current_date - 1)::timestamp';
    await db.exec("set role authenticated; set test.dues_role='membership_editor'");
    await assert.rejects(rpc("'load'"), { code: '42501' });
    await assert.rejects(query('select * from private.dues_receipts'), { code: '42501' });
    await db.exec("set test.dues_role='membership_admin'");
    assert.equal((await rpc("'load'")).members[0].verifiedEmail, 'member@example.test');
    await rpc("'hold', $1, p_note => 'Confirm with Jay'", [email]);
    assert.equal((await rpc("'load'")).holds[email], 'Confirm with Jay');
    const apply = "'apply', $1, array[" + yesterday + "," + yesterday + "], p_name => 'Pending Member'";
    assert.equal((await rpc(apply, [email])).added, 1);
    assert.equal((await rpc(apply, [email])).added, 0);
    let state = await rpc("'load'");
    assert.equal(state.payers[0].roster_name, 'Pending Member');
    assert.equal(state.holds[email], undefined);
    assert.equal(state.receipts[email].length, 1);
    await rpc("'relink', $1, p_member => '00000000-0000-0000-0000-000000000001'", [email]);
    await assert.rejects(rpc(apply, [email]), /already linked/);
    await assert.rejects(rpc("'apply', $1, array[(current_date - 500)::timestamp]", [email]), /last 13 months/);
    await rpc("'review_setting', $1, p_coverage => current_date, p_review_enabled => true", [email]);
    state = await rpc("'load'");
    assert.equal(state.payers[0].review_enabled, true);
    assert.ok(state.payers[0].coverage_through);
    await db.exec('reset role');
    await query('insert into private.dues_receipts(payer_email, received) values ($1, current_date - 500)', [email]);
    await db.exec((await query('select command from cron.jobs'))[0].command);
    assert.equal((await query('select received from private.dues_receipts')).length, 1);
    assert.equal((await query('select last_received from private.dues_payers')).length, 1);
  } finally {
    await db.close();
  }
});
