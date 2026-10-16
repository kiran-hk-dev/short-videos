'use strict';

const config = require('./config');
const log = require('./log');
const dates = require('./dates');
const state = require('./state');
const pipeline = require('./pipeline');

let timer = null;
let ticking = false;
let lastTickAt = null;

/**
 * Which dates need work right now.
 * `ignoreSchedule` is used on startup, so a fresh deploy produces today's
 * video immediately rather than waiting for the slot or a manual trigger.
 */
function plan(now = new Date(), { ignoreSchedule = false } = {}) {
  const lookback = Math.max(0, config.schedule.catchUpDays);
  const candidates = dates.recentKeys(lookback + 1, now);
  const today = dates.dateKey(now);
  const snapshot = state.snapshot();
  const hasHistory = Object.values(snapshot.dates || {}).some((e) => e && e.status === 'completed');
  const due = [];

  for (const key of candidates) {
    const entry = snapshot.dates[key];
    if (entry && entry.status === 'completed') continue;
    if (key === today) {
      if (!ignoreSchedule && !dates.isPastScheduleTime(now)) continue;
      due.push(key);
      continue;
    }
    // Backfill a missed day only when this installation has history and the
    // day has not already been attempted today.
    if (!hasHistory) continue;
    if (entry && entry.updatedAt && dates.dateKey(new Date(entry.updatedAt)) === today) continue;
    due.push(key);
  }

  return due;
}

function retry(dateKey, attempt = 1) {
  const maxAttempts = 3;
  if (attempt >= maxAttempts) {
    log.error('Giving up after repeated failures', { dateKey, attempts: attempt });
    return;
  }
  const waitMs = attempt * 45000;
  log.warn('Retrying a failed run shortly', { dateKey, attempt: attempt + 1, waitSeconds: Math.round(waitMs / 1000) });
  setTimeout(() => {
    pipeline.runDate(dateKey)
      .catch((error) => retry(dateKey, attempt + 1));
  }, waitMs).unref?.();
}

async function tick(reason = 'interval', options = {}) {
  if (ticking) {
    log.debug('Tick already in progress');
    return [];
  }
  ticking = true;
  lastTickAt = new Date().toISOString();
  const done = [];
  try {
    await state.load();
    const due = plan(new Date(), options);
    if (due.length === 0) {
      log.debug('Nothing due', { reason, ist: dates.timeOfDay() });
      return done;
    }
    log.info('Scheduler tick', { reason, due, ist: dates.timeOfDay() });
    for (const dateKey of due) {
      try {
        const result = await pipeline.runDate(dateKey);
        done.push(result);
      } catch (error) {
        log.error('Scheduled run failed', { dateKey, error: error.message });
        retry(dateKey, 1);
      }
    }
  } finally {
    ticking = false;
  }
  return done;
}

function start() {
  if (timer) return timer;
  const ms = config.schedule.intervalMinutes * 60 * 1000;
  log.info('Scheduler started', {
    intervalMinutes: config.schedule.intervalMinutes,
    runsAt: `${String(config.schedule.hour).padStart(2, '0')}:${String(config.schedule.minute).padStart(2, '0')}`,
    timeZone: config.timeZone,
    catchUpDays: config.schedule.catchUpDays,
    runOnStart: config.schedule.runOnStart,
  });

  // Give the HTTP server a moment to bind before the first (heavier) run.
  setTimeout(() => {
    const options = config.schedule.runOnStart ? { ignoreSchedule: true } : {};
    tick(config.schedule.runOnStart ? 'startup-run' : 'startup', options)
      .catch((error) => log.error('Startup tick failed', { error: error.message }));
  }, config.schedule.startupDelaySeconds * 1000).unref?.();

  timer = setInterval(() => {
    tick().catch((error) => log.error('Scheduler tick failed', { error: error.message }));
  }, ms);
  timer.unref?.();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function nextRun() {
  const now = new Date();
  const minutes = dates.minutesOfDay(now);
  const target = config.schedule.hour * 60 + config.schedule.minute;
  if (minutes >= target) {
    return `today's ${config.schedule.hour}:${String(config.schedule.minute).padStart(2, '0')} slot has passed - the next tick catches up`;
  }
  return `in ${target - minutes} min (${config.schedule.hour}:${String(config.schedule.minute).padStart(2, '0')} ${config.timeZone})`;
}

module.exports = { start, stop, tick, plan, nextRun, status: () => ({ running: ticking, lastTickAt }) };