#!/usr/bin/env node
// Compatibility entry point. Public snapshots always use the anon/publishable key.
import { refreshSnapshots } from './snapshots.mjs';
refreshSnapshots(['events']).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
