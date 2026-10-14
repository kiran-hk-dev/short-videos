'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const drive = require('./drive');

const EMPTY = { version: 2, dates: {}, updatedAt: null };

let cache = null;
let remoteFileId = null;
let remoteReady = false;

function readLocal() {
  try {
    if (!fs.existsSync(config.paths.stateFile)) return { ...EMPTY };
    const data = JSON.parse(fs.readFileSync(config.paths.stateFile, 'utf8'));
    if (!data || typeof data !== 'object' || !data.dates) return { ...EMPTY };
    return { version: 2, dates: data.dates || {}, updatedAt: data.updatedAt || null };
  } catch (error) {
    log.warn('Local state file unreadable, starting empty', { error: error.message });
    return { ...EMPTY };
  }
}

function writeLocal(state) {
  fs.mkdirSync(path.dirname(config.paths.stateFile), { recursive: true });
  fs.writeFileSync(config.paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Drive is the durable store: free Render instances lose their disk on every
 * deploy, so completion is also recorded in the destination folder.
 */
async function load() {
  if (cache) return cache;

  const state = readLocal();
  if (config.drive.enabled) {
    try {
      const existing = await drive.findByName(config.drive.stateFileName);
      if (existing) {
        remoteFileId = existing.id;
        const remote = await drive.downloadJson(existing.id);
        if (remote && remote.dates) {
          state.dates = { ...remote.dates, ...state.dates };
          log.info('State loaded from Drive', { fileId: existing.id, dates: Object.keys(state.dates).length });
        }
      }
      remoteReady = true;
    } catch (error) {
      log.warn(`Drive state unavailable (${error.message}) - using local state only`);
    }
  }

  cache = state;
  return cache;
}

function get(dateKey) {
  const state = cache || readLocal();
  return state.dates[dateKey] || null;
}

/** Sync view of the loaded state (local file until load() merges Drive in). */
function snapshot() {
  return cache || readLocal();
}

async function set(dateKey, entry) {
  await load();
  const merged = { ...(cache.dates[dateKey] || {}), ...entry, updatedAt: new Date().toISOString() };
  // A success clears any error left behind by an earlier failed attempt.
  if (merged.status !== 'failed') delete merged.error;
  cache.dates[dateKey] = merged;
  cache.updatedAt = new Date().toISOString();
  writeLocal(cache);

  if (config.drive.enabled && remoteReady) {
    try {
      if (remoteFileId) {
        await drive.updateJson(remoteFileId, cache);
      } else {
        const created = await drive.uploadJson({
          name: config.drive.stateFileName,
          data: cache,
          description: 'Daily Video Automation state (completion ledger)',
        });
        remoteFileId = created.id;
        log.info('State file created in Drive', { fileId: created.id });
      }
    } catch (error) {
      log.warn(`Could not sync state to Drive (${error.message})`);
    }
  }
  return get(dateKey);
}

async function isCompleted(dateKey) {
  const entry = get(dateKey);
  return Boolean(entry && entry.status === 'completed');
}

async function all() {
  const state = await load();
  return state;
}

function reset() {
  cache = null;
  remoteFileId = null;
  remoteReady = false;
}

module.exports = { load, get, set, isCompleted, all, snapshot, reset };