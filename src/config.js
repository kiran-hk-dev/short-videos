'use strict';

const path = require('path');
require('dotenv').config({
  path: process.env.DOTENV_CONFIG_PATH || path.join(__dirname, '..', '.env'),
});

const ROOT = path.resolve(__dirname, '..');

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null || String(v).trim() === '' ? fallback : String(v).trim();
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

function float(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  return /^(1|true|yes|on|enabled)$/i.test(String(v).trim());
}

/**
 * An invalid TZ_NAME makes Intl.DateTimeFormat throw at import time, which
 * takes the whole service down, so fall back to IST and say so.
 */
function validTimeZone(value, fallback = 'Asia/Kolkata') {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return value;
  } catch {
    process.stderr.write(`[WARN] TZ_NAME="${value}" is not a valid IANA time zone; using ${fallback}\n`);
    return fallback;
  }
}

// Defaults are tuned for a 512 MB / 0.5 CPU free instance: small, cheap to
// encode, no motion pass. Raise WIDTH/HEIGHT and set RENDER_MOTION=zoom on a
// bigger machine if you want the full 1080x1920 zoomed version.
const width = int('WIDTH', 720);
const height = int('HEIGHT', 1280);

module.exports = {
  root: ROOT,
  isRender: bool('IS_RENDER', Boolean(process.env.RENDER)),

  timeZone: validTimeZone(str('TZ_NAME', 'Asia/Kolkata')),

  api: {
    token: str('API_TOKEN', ''),
    port: int('PORT', 8080),
    allowOpenCron: bool('ALLOW_OPEN_CRON', true),
  },

  schedule: {
    hour: int('SCHEDULE_HOUR', 15),
    minute: int('SCHEDULE_MINUTE', 42),
    enabled: bool('SCHEDULER_ENABLED', true),
    intervalMinutes: Math.max(1, int('SCHEDULER_INTERVAL_MINUTES', 5)),
    catchUpDays: int('CATCH_UP_DAYS', 1),
    // After every deploy/restart, immediately produce today's video if it is
    // still missing, instead of waiting for the slot or a manual trigger.
    runOnStart: bool('RUN_ON_START', true),
    startupDelaySeconds: int('STARTUP_DELAY_SECONDS', 20),
  },

  paths: {
    outputDir: path.resolve(str('OUTPUT_DIR', path.join(ROOT, 'output'))),
    logFile: path.resolve(str('LOG_FILE', path.join(ROOT, 'logs', 'daily.log'))),
    stateFile: path.resolve(str('STATE_FILE', path.join(ROOT, 'logs', 'completed.json'))),
    credentialsFile: path.resolve(ROOT, str('GOOGLE_CREDENTIALS_FILE', 'credentials.json')),
    tokenFile: path.resolve(ROOT, str('GOOGLE_TOKEN_FILE', 'token.json')),
  },

  ollama: {
    baseUrl: str('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
    model: str('OLLAMA_MODEL', 'llama3.2:3b'),
    timeoutMs: int('OLLAMA_TIMEOUT_MS', 180000),
  },

  story: {
    theme: str('STORY_THEME', 'motivation'),
    words: int('STORY_WORDS', 120),
  },

  tts: {
    engine: str('TTS_ENGINE', 'auto').toLowerCase(),
    rate: int('TTS_RATE', 0),
    piperVoice: str('PIPER_VOICE', ''),
    gttsLang: str('GTTS_LANG', 'en'),
  },

  render: {
    width,
    height,
    fps: int('FPS', 24),
    crf: int('CRF', 28),
    preset: str('PRESET', 'ultrafast'),
    zoomRate: float('ZOOM_RATE', 0.0004),
    zoomScale: float('ZOOM_RENDER_SCALE', 0),
    motion: str('RENDER_MOTION', 'static').toLowerCase(),
    accent: str('ACCENT_COLOR', '#E8B44A'),
    channelName: str('CHANNEL_NAME', 'Daily Short'),
    fontPath: str('FONT_PATH', ''),
    grain: bool('ENABLE_GRAIN', false),
    ffmpeg: str('FFMPEG_PATH', ''),
    ffprobe: str('FFPROBE_PATH', ''),
    maxAudioSeconds: int('MAX_AUDIO_SECONDS', 120),
  },

  drive: {
    folderId: str('GOOGLE_DRIVE_FOLDER_ID', ''),
    serviceAccountEmail: str('GOOGLE_SERVICE_ACCOUNT_EMAIL', ''),
    serviceAccountPrivateKey: str('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', ''),
    uploadStory: bool('UPLOAD_STORY', true),
    stateFileName: str('DRIVE_STATE_FILE', 'daily-state.json'),
    enabled: bool('DRIVE_ENABLED', true),
  },

  // Convenience flags set by the CLI.
  upload: bool('UPLOAD', true),
};

module.exports.HELP = Object.freeze({
  '--once': 'generate (and upload) the video for the India-local date now',
  '--serve': 'start the HTTP backend (GET /health, /status, POST /run, /cron)',
  '--scheduler': 'run only the in-process scheduler loop, no HTTP server',
  '--story-only': 'generate the story JSON and narration text, no video',
  '--date=YYYY-MM-DD': 'target a specific India-local date',
  '--no-upload': 'render but do not upload to Drive',
  '--force': 're-render and re-upload even if the date is already completed',
  '--backfill=N': 'also fill the previous N missing days',
  '--help': 'show this help',
});