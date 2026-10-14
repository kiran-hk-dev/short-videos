'use strict';

/** Environment check: node, ffmpeg/ffprobe, TTS engine, story engine, Drive auth. */

const fs = require('fs');
const config = require('../src/config');
const log = require('../src/log');
const dates = require('../src/dates');
const tools = require('../src/ffmpeg');
const tts = require('../src/tts');
const render = require('../src/render');
const drive = require('../src/drive');
const state = require('../src/state');

function line(ok, label, detail) {
  const mark = ok === null ? '?' : ok ? 'OK  ' : 'FAIL';
  process.stdout.write(`${mark}  ${label.padEnd(26)} ${detail || ''}\n`);
}

async function main() {
  process.stdout.write('Daily Video Automation - doctor\n');
  process.stdout.write(`Time zone ${config.timeZone}: ${dates.dateKey()} ${dates.timeOfDay()} (IST ${dates.offsetMinutes() >= 0 ? '+' : ''}${dates.offsetMinutes() / 60}h)\n`);
  process.stdout.write(`Scheduled slot: ${config.schedule.hour}:${String(config.schedule.minute).padStart(2, '0')} ${config.timeZone}\n\n`);

  line(process.versions.node.split('.')[0] >= 20, 'node', process.version);

  for (const tool of await tools.check()) {
    line(tool.ok, tool.name, tool.ok ? tool.path : tool.error);
  }

  const font = render.findFont();
  line(Boolean(font), 'font for titles', font || 'set FONT_PATH');

  let engine = null;
  try {
    engine = tts.resolveEngine();
  } catch (error) {
    line(false, 'tts engine', error.message);
  }
  if (engine) line(true, 'tts engine', engine);

  let ollamaOk = false;
  let ollamaDetail = 'disabled (OLLAMA_BASE_URL empty) - offline story writer will be used';
  if (config.ollama.baseUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${config.ollama.baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      ollamaOk = res.ok;
      const body = res.ok ? await res.json() : null;
      const models = (body && body.models || []).map((m) => m.name);
      ollamaDetail = res.ok
        ? `${config.ollama.baseUrl} models: ${models.join(', ') || 'none pulled'} (using ${config.ollama.model})`
        : `HTTP ${res.status}`;
    } catch (error) {
      ollamaDetail = `unreachable: ${error.message}`;
    }
  }
  line(ollamaOk, 'ollama', ollamaDetail);

  const authKind = drive.authKind();
  if (authKind === 'none') {
    line(false, 'google drive', 'not configured (service account env vars or credentials.json)');
  } else if (authKind === 'service-account') {
    let ok = false;
    let detail = config.drive.serviceAccountEmail;
    try {
      const d = await drive.getDrive();
      await d.files.list({ pageSize: 1, fields: 'files(id)' });
      ok = true;
      detail += ' - API reachable';
    } catch (error) {
      detail += ` - ${error.message.split('\n')[0]}`;
    }
    line(ok, 'google drive', detail);
  } else {
    line(fs.existsSync(config.paths.tokenFile), 'google drive', `OAuth token ${fs.existsSync(config.paths.tokenFile) ? 'present' : 'missing - run npm run auth'}`);
  }

  line(Boolean(config.drive.folderId), 'drive folder', config.drive.folderId || 'root (blank)');

  const all = await state.all().catch(() => null);
  if (all) {
    const keys = Object.keys(all.dates || {}).sort().slice(-5);
    process.stdout.write(`\nRecent dates in state: ${keys.length ? keys.join(', ') : 'none'}\n`);
  }

  process.stdout.write(`\nOutput dir: ${config.paths.outputDir} (${fs.existsSync(config.paths.outputDir) ? `${fs.readdirSync(config.paths.outputDir).length} files` : 'not created yet'})\n`);
  process.stdout.write(`Log file:   ${config.paths.logFile}\n`);
  log.close();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    log.error('doctor failed', { error: error.message });
    process.exit(1);
  });