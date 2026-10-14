'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('./config');
const log = require('./log');

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const from = y * stride;
    const to = y * (stride + 1);
    raw[to] = 0; // filter: none
    rgb.copy(raw, to + 1, from, from + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- helpers ---- */

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0');
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const PALETTES = [
  { top: '#070b1c', mid: '#101c46', bottom: '#04060f', glow: '#2b4d9c', star: '#e8f0ff' },
  { top: '#0a0618', mid: '#1d1038', bottom: '#05030e', glow: '#5a3aa0', star: '#f0e8ff' },
  { top: '#04121a', mid: '#0b2b38', bottom: '#020a0e', glow: '#1f7a86', star: '#e6fbff' },
  { top: '#120608', mid: '#33121a', bottom: '#0a0304', glow: '#9c2b3c', star: '#ffe9ec' },
  { top: '#0d0f04', mid: '#232a09', bottom: '#060802', glow: '#7e8f2a', star: '#f6ffe0' },
];

/* --------------------------------------------------------------- render ---- */

function renderBackground({ seed = 'default', width, height }) {
  const palette = PALETTES[hashSeed(seed) % PALETTES.length];
  const rand = mulberry32(hashSeed(`stars:${seed}`));

  const top = hexToRgb(palette.top);
  const mid = hexToRgb(palette.mid);
  const bottom = hexToRgb(palette.bottom);
  const glow = hexToRgb(palette.glow);
  const starTint = hexToRgb(palette.star);

  const rgb = Buffer.alloc(width * height * 3);

  // Glow centre wanders a little per seed so daily videos are not identical.
  const glowX = (0.28 + rand() * 0.44) * width;
  const glowY = (0.18 + rand() * 0.3) * height;
  const glowRX = width * (0.55 + rand() * 0.25);
  const glowRY = height * (0.32 + rand() * 0.16);

  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    // three-stop vertical gradient, smoothstepped
    const base = v < 0.55
      ? mix(top, mid, smoothstep(v / 0.55))
      : mix(mid, bottom, smoothstep((v - 0.55) / 0.45));

    for (let x = 0; x < width; x += 1) {
      const dx = (x - glowX) / glowRX;
      const dy = (y - glowY) / glowRY;
      const d = Math.sqrt(dx * dx + dy * dy);
      const glowAmt = d >= 1 ? 0 : (1 - d) * (1 - d) * 0.62;

      let r = base[0] + glow[0] * glowAmt;
      let g = base[1] + glow[1] * glowAmt;
      let b = base[2] + glow[2] * glowAmt;

      // soft diagonal light streak
      const s = (x / width) * 0.65 + (y / height) * 0.35;
      const streak = Math.max(0, 1 - Math.abs(((s * 3) % 1) - 0.5) * 7);
      r += glow[0] * streak * 0.05;
      g += glow[1] * streak * 0.05;
      b += glow[2] * streak * 0.05;

      // vignette
      const vx = (x / width - 0.5) * 2;
      const vy = (y / height - 0.5) * 2;
      const vig = 1 - 0.42 * Math.min(1, Math.pow(Math.sqrt(vx * vx * 0.8 + vy * vy), 2.1));
      r *= vig;
      g *= vig;
      b *= vig;

      // baked bottom scrim so the footer text stays readable without a hard band
      if (v > 0.74) {
        const t = smoothstep((v - 0.74) / 0.26);
        const keep = 1 - 0.55 * t * t;
        r *= keep;
        g *= keep;
        b *= keep;
      }

      const idx = (y * width + x) * 3;
      rgb[idx] = clamp255(r);
      rgb[idx + 1] = clamp255(g);
      rgb[idx + 2] = clamp255(b);
    }
  }

  // Stars, drawn after the gradient so they stay crisp.
  const starCount = Math.round((width * height) / 6800);
  for (let i = 0; i < starCount; i += 1) {
    const x = Math.floor(rand() * width);
    const y = Math.floor(rand() * height);
    const bright = 0.25 + rand() * 0.75;
    const size = bright > 0.92 ? 2 : 1;
    addStar(x, y, size, bright);
  }

  function addStar(x, y, size, bright) {
    const spots = [[0, 0]];
    if (size > 1) {
      spots.push([1, 0], [-1, 0], [0, 1], [0, -1]);
    }
    for (const [dx, dy] of spots) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const idx = (py * width + px) * 3;
      const falloff = dx === 0 && dy === 0 ? 1 : 0.55;
      const add = bright * falloff;
      rgb[idx] = clamp255(rgb[idx] + starTint[0] * add);
      rgb[idx + 1] = clamp255(rgb[idx + 1] + starTint[1] * add);
      rgb[idx + 2] = clamp255(rgb[idx + 2] + starTint[2] * add);
    }
    if (size > 1) {
      // faint halo on the brightest stars
      const halo = bright * 0.18;
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const i2 = (py * width + px) * 3;
        rgb[i2] = clamp255(rgb[i2] + starTint[0] * halo);
        rgb[i2 + 1] = clamp255(rgb[i2 + 1] + starTint[1] * halo);
        rgb[i2 + 2] = clamp255(rgb[i2 + 2] + starTint[2] * halo);
      }
    }
  }

  return encodePng(width, height, rgb);
}

function smoothstep(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Writes output/bg-YYYY-MM-DD.png (deterministic per seed, reused across reruns).
 */
function ensureBackground(dateKey) {
  const { width, height } = config.render;
  const file = path.join(config.paths.outputDir, `bg-${dateKey}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    return file;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  const png = renderBackground({ seed: dateKey, width, height });
  fs.writeFileSync(file, png);
  log.info('Background generated', {
    dateKey,
    file,
    kb: Math.round(png.length / 1024),
    ms: Date.now() - started,
  });
  return file;
}

module.exports = { renderBackground, encodePng, ensureBackground };