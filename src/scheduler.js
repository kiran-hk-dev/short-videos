'use strict';

const config = require('./config');
const log = require('./log');
const dates = require('./dates');
const state = require('./state');
const pipeline = require('./pipeline');

let timer = null;
let ticking = false;

function plan(now = new Date()) {
  const lookback = Math.max(0, config.schedule.catchUpDays);
  const candidates = dates.recentKeys(lookback + 1, now);
  const today = dates.dateKey(now);
  // Only backfill if this installation has completed a day before; a fresh
  // deploy should not immediately produce videos for past dates.
  const hasHistory = Object.values(state.snapshot().dates || {}).some((e) => e && e.status === 'completed');
  const due = [];

  for (const key of candidates) {
    const entry = state.get(key);
    if (entry && entry.status === 'completed') continue;
    if (key === today) {
      if (!dates.isPastScheduleTime(now)) continue;
      due.push(key);
      continue;
    }
    if (!hasHistory) continue;
    // Backfill a missed day only when it has never been attempted today.
    if (entry && entry.updatedAt && dates.dateKey(new Date(entry.updatedAt)) === today) continue;
    due.push(key);
  }

  return due;
}

async function tick(reason = 'interval') {
  if (ticking) {
    log.debug('Tick already in progress');
    return [];
  }
  ticking = true;
  const done = [];
  try {
    await state.load();
    const due = plan();
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
  });
  setTimeout(() => {
    tick('startup').catch((error) => log.error('Startup tick failed', { error: error.message }));
  }, 5000).unref?.();
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

module.exports = { start, stop, tick, plan, nextRun };