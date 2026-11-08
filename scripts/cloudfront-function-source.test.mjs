import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CloudFormation staging function matches the checked-in CloudFront rewrite', async () => {
  const source = await readFile(path.join(root, 'cloudfront/clean-url-rewrite.js'), 'utf8');
  const template = await readFile(path.join(root, 'infrastructure/aws-staging.yaml'), 'utf8');
  const marker = '      FunctionCode: |\n';
  const start = template.indexOf(marker);
  assert.notEqual(start, -1, 'staging function code block exists');
  const contentStart = start + marker.length;
  const end = template.indexOf('\n\n  StagingNoIndexHeaders:', contentStart);
  assert.notEqual(end, -1, 'staging function code block has a following resource');
  const embedded = template
    .slice(contentStart, end)
    .split('\n')
    .map((line) => line.slice(8))
    .join('\n') + '\n';
  assert.equal(embedded, source);
});
