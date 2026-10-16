'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const dates = require('./dates');

/* --------------------------------------------------------- LLM (Ollama) ---- */

const SYSTEM_PROMPT = [
  'You write short spoken scripts for vertical short-form videos.',
  'You always answer with a single JSON object and nothing else.',
].join(' ');

function buildPrompt(dateKey, theme, words) {
  return [
    `Today is ${dates.human(dateKey)}.`,
    `Write a ${words}-word script for a ${words}-second vertical short video about ${theme}.`,
    'Rules:',
    '- Plain spoken English. No markdown, no emoji, no hashtags, no stage directions.',
    '- Open with one short hook sentence, then 3 ideas of one sentence each, then one closing line.',
    '- No statistics, no medical or legal advice, no promises about money or health.',
    '- Make it specific to today and concrete enough to say out loud.',
    '',
    'Return JSON with exactly these string fields:',
    '{"title": "...", "hook": "...", "points": ["...", "...", "..."], "closing": "..."}',
    '- "title": max 6 words, no punctuation at the end.',
    '- "hook": max 22 words.',
    '- each point: max 18 words, lowercase-friendly, no bullet characters.',
    '- "closing": max 14 words, no call to follow/subscribe wording.',
  ].join('\n');
}

/** Only try the LLM when the setting really looks like a URL. */
function ollamaConfigured() {
  const base = (config.ollama.baseUrl || '').trim();
  if (!/^https?:\/\//i.test(base)) {
    if (base) log.warn(`OLLAMA_BASE_URL="${base}" is not a URL - using the offline story writer`);
    return false;
  }
  return true;
}

async function callOllama(dateKey) {
  const base = config.ollama.baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ollama.timeoutMs);
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.ollama.model,
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(dateKey, config.story.theme, config.story.words),
        format: 'json',
        stream: false,
        options: { temperature: 0.85, num_predict: 500 },
      }),
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const data = await res.json();
    return JSON.parse(data.response);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------- offline writer ---- */

const THEMES = {
  motivation: {
    titleWords: ['Start Before You Feel Ready', 'Momentum Beats Motivation', 'One Honest Hour',
      'Show Up Again Tomorrow', 'The Quiet Win', 'Small Is Not Small'],
    hooks: [
      'Most people wait for confidence, but confidence only shows up after the first ugly attempt.',
      'Nobody is watching you practise, and that is exactly why it works.',
      'The gap between wanting something and having it is usually one uncomfortable session.',
      'You do not need a new plan today. You need the plan you already have, used once.',
      'Discipline is not a mood. It is a decision you keep making in the same small room.',
    ],
    points: [
      'Set one task so small that you would feel silly to postpone it.',
      'Put the phone in another room. The first ten minutes are the entire battle.',
      'Write down what you finished, not what you still owe yourself.',
      'Tell one person your plan so that tomorrow has an audience.',
      'Cut the goal in half until finishing feels boring and inevitable.',
      'Finish one thing today, badly, and begin tomorrow with the habit already warm.',
      'Reward the effort, not the outcome, so the habit survives a bad day.',
      'Keep the same time slot tomorrow so the choice is already made.',
    ],
    closings: [
      'Start ugly, finish proud.',
      'One honest hour beats a perfect plan.',
      'Momentum is built, never found.',
      'Tomorrow you will be glad you started.',
    ],
  },
  finance: {
    titleWords: ['Spend Less, Keep More', 'The Two Account Trick', 'Small Leaks, Big Drains',
      'Build a Buffer First', 'Pay Future You', 'A Quiet Money Habit'],
    hooks: [
      'Wealth rarely comes from one big decision. It comes from a hundred small leaks you never noticed.',
      'Before you optimise your income, look at what quietly leaves your account every month.',
      'A budget that fails is not a discipline problem. It is a design problem.',
      'The fastest money move for most households is boring: create a buffer, then spend below it.',
    ],
    points: [
      'Move a fixed amount to savings the day your income arrives, not the day you feel disciplined.',
      'Track spending for seven days without judging it. Patterns show up faster than opinions.',
      'Cancel the subscriptions you forgot you were paying for.',
      'Keep one month of expenses as cash before chasing any investment.',
      'Separate daily money from future money so the choice is made in advance.',
    ],
    closings: [
      'Small leaks, quiet savings, real freedom.',
      'Save first. Spend what is left.',
      'Discipline pays the interest for you.',
    ],
  },
  health: {
    titleWords: ['Sleep Is the Cheapest Fix', 'Move a Little, Often', 'The Honest Recovery Hour',
      'Habits That Heal Slowly', 'Rest Is Training'],
    hooks: [
      'Most people try to fix low energy with intensity when the body is usually asking for regularity.',
      'You do not need a perfect routine. You need one repeatable hour that makes tomorrow easier.',
      'Recovery is not the reward for training. It is the part that makes training work.',
    ],
    points: [
      'Keep the same sleep and wake time, even at the weekend.',
      'Walk after lunch instead of searching for time to exercise later.',
      'Drink water before you reach for a snack.',
      'Take a real screen-free hour before bed.',
      'Stretch cold muscles for five minutes instead of skipping the session.',
    ],
    closings: [
      'Be gentle, be boring, be consistent.',
      'Recovery is part of the work.',
    ],
  },
  focus: {
    titleWords: ['Protect the First Hour', 'Depth Beats Speed', 'The Two List Rule',
      'Attention Is the Budget', 'Finish One Thing'],
    hooks: [
      'You cannot manage time badly and still expect calm. You can only choose what gets your attention.',
      'Scrolling feels productive because it fills the gap while the real work waits.',
      'Every unfinished task quietly takes a percentage of your attention, all day.',
    ],
    points: [
      'Keep two lists: what only you can do, and what can wait.',
      'Do the hardest task before opening any inbox.',
      'Give every meeting a stated outcome, or decline the invite.',
      'Close every tab that is not related to the current task.',
      'Stop one hour earlier tonight by finishing earlier this afternoon.',
    ],
    closings: [
      'Protect your attention like money.',
      'Depth is the advantage you own.',
    ],
  },
  gratitude: {
    titleWords: ['Name One Good Thing', 'The Small Kindness Inventory', 'Notice What Held',
      'A Softer Way to End the Day'],
    hooks: [
      'Attention decides whether a day feels heavy or light, and attention is trainable.',
      'Most good news is quiet when it arrives. Naming it makes it louder.',
      'Gratitude is not pretending everything is fine. It is noticing what is still standing.',
    ],
    points: [
      'Name one thing that went better than expected today.',
      'Thank someone for something they did not have to do.',
      'Write down one problem that stayed small on its own.',
      'Send a short message to someone you rarely talk to.',
      'Finish the day by naming one thing worth repeating tomorrow.',
    ],
    closings: [
      'Notice what held.',
      'Light is a choice you can practise.',
    ],
  },
};

function pick(list, rand) {
  return list[Math.floor(rand() * list.length) % list.length];
}

function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function offlineStory(dateKey) {
  const themeName = Object.prototype.hasOwnProperty.call(THEMES, config.story.theme)
    ? config.story.theme
    : 'motivation';
  const theme = THEMES[themeName];
  const rand = seededRandom(dateKey);
  const points = shuffle(theme.points, rand).slice(0, 4);
  return {
    title: pick(theme.titleWords, rand),
    hook: pick(theme.hooks, rand),
    points,
    closing: pick(theme.closings, rand),
    theme: themeName,
    source: 'offline-template',
  };
}

/* ------------------------------------------------------------- shaping ----- */

function sentence(text) {
  const trimmed = String(text || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const cleaned = trimmed.replace(/^[-*\d.)\s]+/, '');
  const capped = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
}

function normalise(raw, dateKey) {
  const points = Array.isArray(raw && raw.points) ? raw.points : [];
  const title = sentence(raw && raw.title).replace(/\.$/, '');
  const hook = sentence(raw && raw.hook);
  const closing = sentence(raw && raw.closing);
  const usable = points.map(sentence).filter((p) => p.split(/\s+/).length >= 4).slice(0, 4);
  if (!title || !hook || usable.length < 2) throw new Error('story JSON was unusable');
  return {
    title,
    hook,
    points: usable,
    closing: closing || 'Tomorrow is a good day to begin.',
    theme: config.story.theme,
    source: 'ollama',
  };
}

function narrationText(story) {
  return [story.hook, ...story.points, story.closing]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function writeStoryFile(dateKey, story) {
  const file = path.join(config.paths.outputDir, `story-${dateKey}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    date: dateKey,
    generatedAt: new Date().toISOString(),
    model: story.source === 'ollama' ? config.ollama.model : 'offline-template',
    story,
    narration: narrationText(story),
    words: narrationText(story).split(/\s+/).length,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return { file, payload };
}

function loadStoryFile(dateKey) {
  const file = path.join(config.paths.outputDir, `story-${dateKey}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.story && data.story.title) return data;
  } catch {
    /* fall through to regeneration */
  }
  return null;
}

/**
 * Reuses output/story-YYYY-MM-DD.json when present so a rerun after a failed
 * upload keeps the exact same script.
 */
async function getStory(dateKey, { force = false } = {}) {
  if (!force) {
    const cachedStory = loadStoryFile(dateKey);
    if (cachedStory) {
      log.info('Story reused from disk', { dateKey, file: `story-${dateKey}.json` });
      return cachedStory;
    }
  }

  let story;
  if (ollamaConfigured()) {
    try {
      story = normalise(await callOllama(dateKey), dateKey);
      log.info('Story generated with Ollama', { model: config.ollama.model, dateKey });
    } catch (error) {
      log.warn(`Ollama unavailable (${error.message}) - using offline writer`);
    }
  }

  if (!story) story = offlineStory(dateKey);

  const { file, payload } = writeStoryFile(dateKey, story);
  log.info('Story written', { dateKey, file, words: payload.words, source: payload.model });
  return payload;
}

module.exports = { getStory, narrationText, offlineStory, loadStoryFile };