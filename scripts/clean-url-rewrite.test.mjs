import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../cloudfront/clean-url-rewrite.js', import.meta.url), 'utf8');
const context = {};
runInNewContext(`${source}\nthis.rewriteRequest = handler;`, context);

test('rewrites the friendly website routes to published HTML files', () => {
  for (const [uri, expected] of [
    ['/store', '/store.html'],
    ['/slideshow', '/slideshow.html'],
    ['/slideshow/play', '/slideshow-play.html'],
  ]) {
    const request = { uri, method: 'GET', querystring: { source: { value: 'club' } } };
    const result = context.rewriteRequest({ request });
    assert.equal(result.uri, expected);
    assert.deepEqual(result.querystring, request.querystring);
  }
});

test('leaves unrelated paths unchanged', () => {
  const request = { uri: '/members.html', method: 'GET' };
  assert.equal(context.rewriteRequest({ request }).uri, '/members.html');
});
