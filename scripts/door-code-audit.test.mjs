import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('door-code changes write a members audit event without logging the secret', async () => {
  const sql = await read('supabase/migrations/20260924115500_audit_door_code_changes.sql');

  assert.match(sql, /insert into public\.audit_log/);
  assert.match(sql, /'members'/);
  assert.match(sql, /'door_code'/);
  assert.match(sql, /'club_door'/);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /'Club door code'/);
  assert.match(sql, /'secret_value_logged', false/);

  const auditInsert = sql.slice(sql.indexOf('insert into public.audit_log'));
  assert.doesNotMatch(auditInsert, /v_trimmed|p_code|\bcode\b\s*:/i);
});
