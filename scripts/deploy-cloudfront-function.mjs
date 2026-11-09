#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const functionNames = {
  staging: 'snhpc-staging-site-clean-url-rewrite',
  production: 'snhpc-website-clean-url-rewrite',
};
const siteEnvironment = process.env.SITE_ENV;
const functionName = functionNames[siteEnvironment];

if (!functionName) {
  throw new Error('SITE_ENV must be staging or production.');
}

const sourcePath = path.join(repositoryRoot, 'cloudfront', 'clean-url-rewrite.js');
const functionCode = await readFile(sourcePath);
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'snhpc-cloudfront-function-'));

function awsJson(args) {
  const stdout = execFileSync('aws', ['cloudfront', ...args, '--output', 'json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

try {
  const description = awsJson([
    'describe-function',
    '--name', functionName,
    '--stage', 'DEVELOPMENT',
  ]);
  const currentConfig = description.FunctionSummary?.FunctionConfig;
  if (!description.ETag || !currentConfig) {
    throw new Error('CloudFront did not return the current function configuration and ETag.');
  }
  if (currentConfig.Runtime !== 'cloudfront-js-2.0') {
    throw new Error('Expected cloudfront-js-2.0 for ' + functionName + '.');
  }

  const codePath = path.join(tempDirectory, 'clean-url-rewrite.js');
  const configPath = path.join(tempDirectory, 'function-config.json');
  await writeFile(codePath, functionCode);
  await writeFile(configPath, JSON.stringify(currentConfig));

  const updated = awsJson([
    'update-function',
    '--name', functionName,
    '--if-match', description.ETag,
    '--function-config', 'file://' + configPath,
    '--function-code', 'fileb://' + codePath,
  ]);
  if (!updated.ETag) throw new Error('CloudFront did not return an ETag after updating the function.');

  const cases = [
    ['/donate', '/donate.html'],
    ['/store', '/store.html'],
    ['/slideshow', '/slideshow.html'],
    ['/slideshow/play', '/slideshow-play.html'],
    ['/members.html', '/members.html'],
  ];

  for (const [uri, expectedUri] of cases) {
    const event = {
      version: '1.0',
      context: {
        distributionDomainName: 'd111111abcdef8.cloudfront.net',
        distributionId: 'EDFDVBD6EXAMPLE',
        eventType: 'viewer-request',
        requestId: 'SNHPC-CLEAN-URL-TEST',
      },
      viewer: { ip: '192.0.2.1' },
      request: {
        method: 'GET',
        uri,
        querystring: {},
        headers: {},
        cookies: {},
      },
    };
    const eventPath = path.join(tempDirectory, 'event.json');
    await writeFile(eventPath, JSON.stringify(event));
    const result = awsJson([
      'test-function',
      '--name', functionName,
      '--if-match', updated.ETag,
      '--event-object', 'fileb://' + eventPath,
      '--stage', 'DEVELOPMENT',
    ]).TestResult;

    if (result?.FunctionErrorMessage) {
      throw new Error('CloudFront test failed for ' + uri + ': ' + result.FunctionErrorMessage);
    }
    const output = JSON.parse(result?.FunctionOutput || '{}');
    const actualUri = output.request?.uri;
    if (actualUri !== expectedUri) {
      throw new Error('CloudFront test expected ' + expectedUri + ' for ' + uri + ', got ' + actualUri + '.');
    }
  }

  const published = awsJson([
    'publish-function',
    '--name', functionName,
    '--if-match', updated.ETag,
  ]);
  const stage = published.FunctionSummary?.FunctionMetadata?.Stage;
  console.log('Published ' + functionName + ' to ' + (stage || 'LIVE') + ' after ' + cases.length + ' passing CloudFront tests.');
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
