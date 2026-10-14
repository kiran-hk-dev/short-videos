'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

let stream = null;

function ensureStream() {
  if (stream) return stream;
  const dir = path.dirname(config.paths.logFile);
  try {
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(config.paths.logFile, { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
  } catch {
    stream = null;
  }
  return stream;
}

function emit(level, message, meta) {
  let line = `${new Date().toISOString()} [${level}] ${message}`;
  if (meta && Object.keys(meta).length) {
    line += ` ${JSON.stringify(meta)}`;
  }
  if (level === 'ERROR') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
  const s = ensureStream();
  if (s) s.write(`${line}\n`);
}

module.exports = {
  debug: (m, meta) => emit('DEBUG', m, meta),
  info: (m, meta) => emit('INFO', m, meta),
  warn: (m, meta) => emit('WARN', m, meta),
  error: (m, meta) => emit('ERROR', m, meta),
  close: () => {
    if (stream) stream.end();
    stream = null;
  },
};