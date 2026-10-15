'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const tools = require('./ffmpeg');

/** Every artefact of the current container's disk (ephemeral on free tiers). */
function list() {
  const dir = config.paths.outputDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => {
      const file = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        return null;
      }
      if (!stat.isFile()) return null;
      return {
        name,
        sizeBytes: stat.size,
        sizeMB: Number((stat.size / 1048576).toFixed(2)),
        createdAt: stat.mtime.toISOString(),
        isVideo: name.endsWith('.mp4'),
        isAudio: /\.(wav|mp3|m4a|ogg)$/.test(name),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function withDurations(files) {
  const out = [];
  for (const file of files) {
    let durationSeconds = null;
    if (file.isVideo || file.isAudio) {
      if (file.sizeBytes === 0) {
        file.problem = 'empty file - the render was interrupted before writing any frames';
      } else {
        try {
          const seconds = await tools.probeDurationSeconds(path.join(config.paths.outputDir, file.name));
          durationSeconds = seconds ? Number(seconds.toFixed(1)) : null;
          if (seconds === null) file.problem = 'not a readable media file - incomplete render';
        } catch (error) {
          durationSeconds = null;
          file.problem = String(error.message).split('\n')[0];
        }
      }
    }
    out.push({ ...file, durationSeconds });
  }
  return out;
}

/** Resolves a caller-supplied name inside the output dir only (no traversal). */
function resolveFile(name) {
  const safe = path.basename(String(name || ''));
  if (!safe || safe === '.' || safe === '..') return null;
  const file = path.resolve(config.paths.outputDir, safe);
  if (!file.startsWith(path.resolve(config.paths.outputDir) + path.sep)) return null;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

module.exports = { list, withDurations, resolveFile };