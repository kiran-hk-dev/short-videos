'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const log = require('./log');

function fromPathDirs(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function which(name) {
  return fromPathDirs(name);
}

let cached = {};

function resolve(name) {
  if (cached[name]) return cached[name];
  const override = name === 'ffmpeg' ? configFFmpeg() : name === 'ffprobe' ? configFfprobe() : '';
  const bin = override && fs.existsSync(override) ? override : which(name) || name;
  cached[name] = bin;
  return bin;
}

function configFFmpeg() {
  // Lazily read config to avoid a circular require at module load time.
  return require('./config').render.ffmpeg;
}

function configFfprobe() {
  return require('./config').render.ffprobe;
}

function run(bin, args, { input, label, timeoutMs = 20 * 60 * 1000, quiet = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const child = execFile(
      bin,
      args,
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        if (error) {
          const tail = String(stderr || '').trim().split('\n').slice(-12).join('\n');
          const shortCommand = [bin, ...args]
            .map((a) => (a.length > 160 ? `${a.slice(0, 160)}...` : a))
            .join(' ');
          log.error(`${label || bin} failed after ${seconds}s`, { error: error.message });
          log.debug(`command: ${shortCommand}`);
          if (tail) log.error(`${label || bin} stderr tail: ${tail}`);
          rejectPromise(new Error(`${label || path.basename(bin)} failed: ${error.message}\n${tail}`));
          return;
        }
        if (!quiet && seconds > 5) log.debug(`${label || bin} ok in ${seconds}s`);
        resolvePromise({ stdout: stdout || '', stderr: stderr || '' });
      },
    );
    if (child.stdin && input !== undefined && input !== null) {
      child.stdin.end(Buffer.isBuffer(input) ? input : String(input));
    }
  });
}

function ffmpeg(args, opts) {
  return run(resolve('ffmpeg'), args, { label: 'ffmpeg', ...opts });
}

function ffprobe(args, opts) {
  return run(resolve('ffprobe'), args, { label: 'ffprobe', quiet: true, ...opts });
}

async function probeDurationSeconds(file) {
  const { stdout } = await ffprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const seconds = Number.parseFloat(String(stdout).trim());
  return Number.isFinite(seconds) ? seconds : null;
}

async function check() {
  const results = [];
  for (const [name, args] of [['ffmpeg', ['-version']], ['ffprobe', ['-version']]]) {
    try {
      await run(resolve(name), args, { quiet: true, timeoutMs: 30000 });
      results.push({ name, ok: true, path: resolve(name) });
    } catch (error) {
      results.push({ name, ok: false, path: resolve(name), error: error.message.split('\n')[0] });
    }
  }
  return results;
}

module.exports = { resolve, run, ffmpeg, ffprobe, probeDurationSeconds, check };