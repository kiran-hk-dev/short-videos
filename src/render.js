'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const tools = require('./ffmpeg');
const dates = require('./dates');
const system = require('./system');

/* ------------------------------------------------------------------ text ---- */

const FONT_CANDIDATES = {
  linux: [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
  ],
  darwin: [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
  ],
};

let cachedFont;

function findFont() {
  if (cachedFont !== undefined) return cachedFont;
  if (config.render.fontPath && fs.existsSync(config.render.fontPath)) {
    cachedFont = config.render.fontPath;
    return cachedFont;
  }
  const list = FONT_CANDIDATES[process.platform] || FONT_CANDIDATES.linux;
  cachedFont = list.find((p) => fs.existsSync(p)) || null;
  if (!cachedFont) log.warn('No TTF font found for drawtext - set FONT_PATH to avoid a render failure');
  return cachedFont;
}

/** Escapes a value so it survives ffmpeg's filter parser inside single quotes. */
function esc(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/%/g, '\\%');
}

/** Paths: forward slashes work everywhere, only the drive colon needs escaping. */
function escPath(value) {
  return String(value)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

/** `#rrggbb` breaks filter parsing, `0xrrggbb` does not. */
function color(value, alpha) {
  const hex = String(value).trim().replace('#', '');
  return alpha === undefined ? `0x${hex}` : `0x${hex}@${alpha}`;
}

function wrap(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === 0) return [];
  if (lines.length === maxLines) {
    const consumed = lines.join(' ').split(/\s+/).length;
    if (consumed < words.length) {
      lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[,.;:]$/, '')}.`;
    }
  }
  return lines;
}

/* ----------------------------------------------------------------- filter --- */

/**
 * The zoom pass is the expensive step: zoompan scales every output pixel.
 * On a memory-starved free instance it renders the motion at a reduced size and
 * upscales afterwards, which cuts both RAM and CPU roughly fourfold.
 * Set ZOOM_RENDER_SCALE to override (1 = always full resolution).
 */
function zoomRenderSize(width, height) {
  const configured = Number(config.render.zoomScale);
  const limit = system.memoryLimitMB();
  let scale = Number.isFinite(configured) && configured > 0 ? configured : 1;
  if (!Number.isFinite(configured) || configured <= 0) {
    // Auto: shrink when the container has less than ~700 MB to play with.
    if (limit < 700) scale = 0.5;
    if (limit < 400) scale = 0.34;
  }
  const w = Math.max(270, Math.round((width * scale) / 2) * 2);
  const h = Math.max(480, Math.round((height * scale) / 2) * 2);
  return { w, h, scale: w / width, memoryLimitMB: limit };
}

function buildFilter({ duration, story, footer, motion = 'zoom' }) {
  const { width, height, fps, accent, zoomRate, channelName, grain } = config.render;
  const dur = Math.max(2, duration);
  const font = findFont();
  const fontArg = font ? `:fontfile='${escPath(font)}'` : '';
  const zoom = zoomRenderSize(width, height);

  const titleSize = Math.round(width * 0.062);
  const hookSize = Math.round(width * 0.037);
  const pointSize = Math.round(width * 0.041);
  const footerSize = Math.round(width * 0.030);
  const lineHeight = Math.round(titleSize * 1.22);
  const ruleThickness = Math.max(4, Math.round(height * 0.0035));

  const titleChars = Math.max(10, Math.floor(width / (titleSize * 0.53)));
  const hookChars = Math.max(18, Math.floor(width / (hookSize * 0.5)));
  const pointChars = Math.max(18, Math.floor(width / (pointSize * 0.52)));

  const titleLines = wrap(story.title, titleChars, 3);
  const hookLines = wrap(story.hook, hookChars, 3);
  const points = (story.points || []).slice(0, 4);

  const topBlockHeight = Math.round(height * 0.28);
  const titleBottom = topBlockHeight + Math.round((titleLines.length * lineHeight) / 2);
  const accentY = titleBottom + Math.round(height * 0.018);
  const hookY = accentY + Math.round(height * 0.035);
  const ruleWidth = Math.round(width * 0.26);

  const graph = [];

  // Slow cinematic push-in over the still background. `static` motion is the
  // cheap fallback for instances too small to survive per-frame zoompan.
  const head = motion === 'zoom'
    ? `[0:v]zoompan=z='min(1+${zoomRate}*on,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
      + `:d=1:s=${zoom.w}x${zoom.h}:fps=${fps},setsar=1`
      + (zoom.scale < 1 ? `,scale=${width}:${height}:flags=bicubic` : '')
      + '[bg]'
    : `[0:v]scale=${width}:${height},setsar=1[bg]`;
  graph.push(head);

  const steps = [];

  // Title
  titleLines.forEach((line, i) => {
    const y = topBlockHeight - (titleLines.length * lineHeight) / 2 + i * lineHeight + titleSize * 0.5;
    steps.push(`drawtext=text='${esc(line)}'${fontArg}:fontcolor=white:fontsize=${titleSize}`
      + `:x=(w-text_w)/2:y=${Math.round(y)}:borderw=${Math.max(2, Math.round(titleSize * 0.06))}`
      + `:bordercolor=black@0.55:shadowx=0:shadowy=${Math.max(2, Math.round(titleSize * 0.04))}`
      + `:shadowcolor=black@0.6:enable='gte(t,0.4)*lt(t,${(dur - 0.6).toFixed(2)})'`);
  });

  // Accent rule that grows in over the first seconds (iw/ih: `w`/`h` are the box size here).
  steps.push(`drawbox=x='(iw-${ruleWidth})/2':y=${accentY}:w='${ruleWidth}*min(1,t/1.2)':h=${ruleThickness}`
    + `:color=${color(accent, 0.95)}:t=fill:enable='lt(t,${(dur - 0.4).toFixed(2)})'`);

  // Hook
  hookLines.forEach((line, i) => {
    const y = hookY + i * Math.round(hookSize * 1.35);
    steps.push(`drawtext=text='${esc(line)}'${fontArg}:fontcolor=white@0.88:fontsize=${hookSize}`
      + `:x=(w-text_w)/2:y=${Math.round(y)}:enable='gte(t,1.4)*lt(t,${(dur - 0.6).toFixed(2)})'`);
  });

  // Points, revealed one at a time.
  const pointStart = Math.min(dur - 2.5, 4.5);
  const pointStep = Math.max(3.2, (dur - pointStart - 1.5) / Math.max(1, points.length));
  points.forEach((point, i) => {
    const lines = wrap(point, pointChars, 2);
    const start = pointStart + i * pointStep;
    const end = i === points.length - 1 ? dur - 0.5 : start + pointStep - 0.4;
    if (start >= end) return;
    const blockTop = Math.round(height * (points.length >= 4 ? 0.44 + i * 0.105 : 0.47 + i * 0.12));
    lines.forEach((line, j) => {
      const y = blockTop + j * Math.round(pointSize * 1.3);
      steps.push(`drawtext=text='${esc(line)}'${fontArg}:fontcolor=white@0.95:fontsize=${pointSize}`
        + `:x=(w-text_w)/2:y=${Math.round(y)}:borderw=${Math.max(1, Math.round(pointSize * 0.05))}`
        + `:bordercolor=black@0.45:enable='gte(t,${start.toFixed(2)})*lt(t,${end.toFixed(2)})'`);
    });
  });

  // Footer + progress bar (the bottom scrim is baked into the background image).
  steps.push(`drawtext=text='${esc(`${channelName}  •  ${footer}`)}'${fontArg}:fontcolor=white@0.75`
    + `:fontsize=${footerSize}:x=(w-text_w)/2:y=${Math.round(height * 0.945)}`);
  steps.push(`drawbox=x=0:y=${height - ruleThickness}:w='${width}*min(1,t/${dur.toFixed(2)})'`
    + `:h=${ruleThickness}:color=${color(accent, 0.9)}:t=fill`);

  if (grain) steps.push('noise=alls=7:allf=t+u');

  steps.push(`fade=t=in:st=0:d=0.6,fade=t=out:st=${Math.max(0, dur - 0.8).toFixed(2)}:d=0.8,format=yuv420p`);

  graph.push(`[bg]${steps.join(',')}[outv]`);
  return graph.join(';');
}

/* ----------------------------------------------------------------- render --- */

/**
 * Renders the vertical MP4 and returns its path.
 * An existing file of the same name is reused unless `force` is set.
 */
async function renderVideo({ backgroundFile, audioFile, story, dateKey, duration, force = false }) {
  const { width, height, fps, crf, preset } = config.render;
  if (!findFont()) {
    throw new Error(
      'No usable TTF font for drawtext. Install a font package (fonts-dejavu-core) or set FONT_PATH to a .ttf file.',
    );
  }
  fs.mkdirSync(config.paths.outputDir, { recursive: true });
  const outFile = path.join(config.paths.outputDir, `daily-short-${dateKey.replace(/-/g, '')}.mp4`);

  if (!force && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
    log.info('MP4 reused from disk', { file: outFile });
    return outFile;
  }

  if (!fs.existsSync(backgroundFile)) throw new Error(`background not found: ${backgroundFile}`);
  if (!fs.existsSync(audioFile)) throw new Error(`audio not found: ${audioFile}`);

  let seconds = duration || (await tools.probeDurationSeconds(audioFile));
  if (!seconds || !Number.isFinite(seconds)) throw new Error('could not determine audio duration');
  if (seconds > config.render.maxAudioSeconds) {
    log.warn('Audio longer than MAX_AUDIO_SECONDS - truncating', { seconds, cap: config.render.maxAudioSeconds });
    seconds = config.render.maxAudioSeconds;
  }
  seconds = Math.max(2, seconds + 0.8);

  const started = Date.now();
  const footer = dates.human(dateKey);

  const buildArgs = (motion) => [
    '-y',
    '-loop', '1',
    '-framerate', String(fps),
    '-i', backgroundFile,
    '-i', audioFile,
    '-filter_complex', buildFilter({ duration: seconds, story, footer, motion }),
    '-map', '[outv]',
    '-map', '1:a',
    '-t', seconds.toFixed(2),
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-maxrate', '2500k',
    '-bufsize', '5000k',
    '-profile:v', 'high',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    '-metadata', `title=Daily Short ${dateKey}`,
    outFile,
  ];

  const cleanupPartial = () => {
    try {
      const partial = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
      fs.rmSync(outFile, { force: true });
      log.warn('Partial MP4 removed after a failed render', { file: outFile, partialBytes: partial });
    } catch {
      /* ignore */
    }
  };

  let motion = config.render.motion === 'auto' || !config.render.motion ? 'zoom' : config.render.motion;

  try {
    await tools.ffmpeg(buildArgs(motion), { label: 'render' });
  } catch (error) {
    cleanupPartial();
    if (motion === 'zoom') {
      // Free instances regularly run out of memory on the per-frame zoom;
      // a still-frame render is cheap and still produces a complete video.
      log.warn('Zoom render failed, retrying without motion', { error: String(error.message).split('\n')[0] });
      motion = 'static';
      try {
        await tools.ffmpeg(buildArgs('static'), { label: 'render-static' });
      } catch (staticError) {
        cleanupPartial();
        throw staticError;
      }
    } else {
      throw error;
    }
  }
  const stat = fs.statSync(outFile);
  log.info('MP4 rendered', {
    file: outFile,
    mb: (stat.size / (1024 * 1024)).toFixed(2),
    bytes: stat.size,
    seconds,
    motion,
    renderSeconds: Math.round((Date.now() - started) / 1000),
    size: `${width}x${height}@${fps}`,
    zoomScale: motion === 'zoom' ? zoomRenderSize(width, height).scale : null,
  });
  return outFile;
}

module.exports = { renderVideo, buildFilter, wrap, findFont, zoomRenderSize, plan: () => ({ ...zoomRenderSize(config.render.width, config.render.height), preset: config.render.preset }) };