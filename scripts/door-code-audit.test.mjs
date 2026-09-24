import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('door-code reveals write a members view audit event without logging the secret', async () => {
  const sql = await read('supabase/migrations/20260924115500_audit_door_code_changes.sql');
  const getterStart = sql.indexOf('create or replace function public.snh_get_door_code()');
  const setterStart = sql.indexOf('create or replace function public.snh_set_door_code');
  const getterSql = sql.slice(getterStart, setterStart);

  assert.ok(getterStart >= 0 && setterStart > getterStart);
  assert.match(getterSql, /insert into public\.audit_log/);
  assert.match(getterSql, /'members'/);
  assert.match(getterSql, /'view'/);
  assert.match(getterSql, /'door_code'/);
  assert.match(getterSql, /'club_door'/);
  assert.match(getterSql, /auth\.uid\(\)/);
  assert.match(getterSql, /'status', 'viewed'/);
  assert.match(getterSql, /'secret_value_logged', false/);

  const auditInsert = getterSql.slice(getterSql.indexOf('insert into public.audit_log'));
  assert.doesNotMatch(auditInsert, /jsonb_build_object\([^)]*v_code/i);
});

test('door-code changes write a members audit event without logging the secret', async () => {
  const sql = await read('supabase/migrations/20260924115500_audit_door_code_changes.sql');
  const setterStart = sql.indexOf('create or replace function public.snh_set_door_code');
  const setterSql = sql.slice(setterStart);

  assert.ok(setterStart >= 0);
  assert.match(setterSql, /insert into public\.audit_log/);
  assert.match(setterSql, /'members'/);
  assert.match(setterSql, /'door_code'/);
  assert.match(setterSql, /'club_door'/);
  assert.match(setterSql, /auth\.uid\(\)/);
  assert.match(setterSql, /'Club door code'/);
  assert.match(setterSql, /'secret_value_logged', false/);

  const auditInsert = setterSql.slice(setterSql.indexOf('insert into public.audit_log'));
  assert.doesNotMatch(auditInsert, /v_trimmed|p_code|\bcode\b\s*:/i);
});
