'use strict';

const config = require('./config');

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function parts(date = new Date()) {
  const out = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

/** YYYY-MM-DD for the configured time zone. */
function dateKey(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** YYYYMMDD, used for MP4 file names. */
function compactDate(key) {
  return key.replace(/-/g, '');
}

function human(key) {
  const [y, m, d] = key.split('-');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

function minutesOfDay(date = new Date()) {
  const p = parts(date);
  return Number(p.hour) * 60 + Number(p.minute);
}

function timeOfDay(date = new Date()) {
  const p = parts(date);
  return `${p.hour}:${p.minute}`;
}

function offsetMinutes(date = new Date()) {
  const p = parts(date);
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute),
  );
  const local = new Date(date);
  const guess = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    local.getUTCHours(), local.getUTCMinutes(),
  );
  return Math.round((asUtc - guess) / 60000);
}

function scheduleMinutes() {
  return config.schedule.hour * 60 + config.schedule.minute;
}

/** Has today's schedule time already passed in the configured time zone? */
function isPastScheduleTime(date = new Date()) {
  return minutesOfDay(date) >= scheduleMinutes();
}

function shiftKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** [today, today-1, ...] capped at `count`. */
function recentKeys(count, now = new Date()) {
  const today = dateKey(now);
  const keys = [];
  for (let i = 0; i < Math.max(1, count); i++) keys.push(shiftKey(today, -i));
  return keys;
}

function isValidKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

module.exports = {
  dateKey,
  compactDate,
  human,
  timeOfDay,
  minutesOfDay,
  offsetMinutes,
  scheduleMinutes,
  isPastScheduleTime,
  shiftKey,
  recentKeys,
  isValidKey,
};