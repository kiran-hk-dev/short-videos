'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const tools = require('./ffmpeg');

function availableOnPath(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    try {
      if (fs.existsSync(path.join(dir, bin))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Order matters: fully offline engines first, network TTS last.
 * Render/Koyeb/Railway images ship espeak-ng; piper can be dropped in for
 * neural voices, and gTTS is the always-works fallback.
 */
function resolveEngine(requested) {
  const want = (requested || config.tts.engine || 'auto').toLowerCase();
  const auto = want === 'auto';

  const candidates = [];
  if (auto || want === 'piper') candidates.push('piper');
  if (auto || want === 'espeak') candidates.push('espeak');
  if (auto || want === 'gtts') candidates.push('gtts');

  for (const engine of candidates) {
    if (engine === 'piper' && config.tts.piperVoice && availableOnPath('piper')) return 'piper';
    if (engine === 'espeak' && (availableOnPath('espeak-ng') || availableOnPath('espeak'))) return 'espeak';
    if (engine === 'gtts') return 'gtts';
  }

  throw new Error(
    'No usable TTS engine. Install espeak-ng (present in the bundled Dockerfile) or the optional "gtts" package.',
  );
}

async function withPiper(text, outFile) {
  await tools.run(
    'piper',
    ['--model', config.tts.piperVoice, '--output_file', outFile],
    { label: 'piper-tts', input: `${text}\n`, timeoutMs: 10 * 60 * 1000 },
  );
}

async function withEspeak(text, outFile) {
  const bin = availableOnPath('espeak-ng') ? 'espeak-ng' : 'espeak';
  const args = ['-v', 'en-us', '-s', '165', '-p', '45', '-a', '170', '-w', outFile];
  await tools.run(bin, args, { label: 'espeak-tts', input: `${text}\n`, timeoutMs: 10 * 60 * 1000 });
}

/**
 * Free fallback: Google Translate's public TTS endpoint, called directly so the
 * project needs no extra dependency. It is rate limited and may refuse requests
 * from some data-centre IPs, so it is always the last resort.
 */
async function withGtts(text, outFile) {
  const lang = encodeURIComponent(config.tts.gttsLang || 'en');
  const chunks = splitForGtts(text);
  const parts = [];

  for (const chunk of chunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(chunk)}`;
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        accept: 'audio/mpeg,*/*',
      },
    });
    if (!res.ok) throw new Error(`gTTS HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new Error('gTTS returned no audio');
    parts.push(buffer);
  }

  fs.writeFileSync(outFile, Buffer.concat(parts));
}

/** The endpoint truncates long queries, so send sentence-sized pieces. */
function splitForGtts(text, limit = 180) {
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (current && (current + ' ' + piece).length > limit) {
      chunks.push(current);
      current = piece;
      continue;
    }
    if (piece.length > limit) {
      const words = piece.split(/\s+/);
      for (const word of words) {
        if ((current + ' ' + word).length > limit && current) {
          chunks.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      continue;
    }
    current = current ? `${current} ${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.slice(0, limit)];
}

const ENGINES = {
  piper: { run: withPiper, ext: '.wav' },
  espeak: { run: withEspeak, ext: '.wav' },
  gtts: { run: withGtts, ext: '.mp3' },
};

/**
 * Synthesises `text` to output/voice-YYYY-MM-DD.<ext> and returns the path.
 * Existing files are reused so a rerun keeps the same voice track.
 */
async function synthesize(text, dateKey, { force = false } = {}) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('narration text is empty');

  fs.mkdirSync(config.paths.outputDir, { recursive: true });
  for (const ext of ['.wav', '.mp3', '.m4a', '.ogg']) {
    const cachedFile = path.join(config.paths.outputDir, `voice-${dateKey}${ext}`);
    if (!force && fs.existsSync(cachedFile) && fs.statSync(cachedFile).size > 0) {
      log.info('Voice track reused from disk', { file: cachedFile });
      return cachedFile;
    }
  }

  const engine = resolveEngine();
  const impl = ENGINES[engine];
  const outFile = path.join(config.paths.outputDir, `voice-${dateKey}${impl.ext}`);
  const started = Date.now();
  await impl.run(clean, outFile);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const kb = Math.round(fs.statSync(outFile).size / 1024);
  log.info('Voice track generated', { engine, file: outFile, kb, seconds });
  return outFile;
}

module.exports = { synthesize, resolveEngine };