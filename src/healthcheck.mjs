#!/usr/bin/env node
// Container health check: healthy if the main loop finished a pass within the last 3 minutes
// (or 3 poll intervals, whichever is longer).
import fs from 'node:fs';
import { loadConfig } from './config.mjs';

const { cfg } = loadConfig();
const maxAge = Math.max(180000, cfg.interval * 3);
try {
  const age = Date.now() - Number(fs.readFileSync(cfg.heartbeatFile, 'utf8'));
  if (age > maxAge) { console.error(`last successful pass ${Math.round(age / 1000)}s ago`); process.exit(1); }
} catch (e) {
  console.error(`no heartbeat yet (${e.code || e.message})`); process.exit(1);
}
