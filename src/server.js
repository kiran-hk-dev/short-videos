'use strict';

const express = require('express');
const config = require('./config');
const log = require('./log');
const dates = require('./dates');
const state = require('./state');
const pipeline = require('./pipeline');
const scheduler = require('./scheduler');
const drive = require('./drive');
const tts = require('./tts');
const selftest = require('./selftest');

const startedAt = new Date();
let lastRun = null;

function publicConfig() {
  return {
    timeZone: config.timeZone,
    schedule: `${String(config.schedule.hour).padStart(2, '0')}:${String(config.schedule.minute).padStart(2, '0')}`,
    schedulerEnabled: config.schedule.enabled,
    schedulerIntervalMinutes: config.schedule.intervalMinutes,
    catchUpDays: config.schedule.catchUpDays,
    size: `${config.render.width}x${config.render.height}@${config.render.fps}`,
    theme: config.story.theme,
    ttsEngine: config.tts.engine,
    ollama: config.ollama.baseUrl ? `${config.ollama.baseUrl} (${config.ollama.model})` : 'off (offline writer)',
    driveAuth: drive.authKind(),
    driveFolder: config.drive.folderId || 'root',
  };
}

function authorised(req) {
  const expected = config.api.token;
  if (!expected) return config.api.allowOpenCron;
  const header = req.get('x-api-token') || req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const given = req.query.token || bearer || header;
  return given === expected;
}

function create() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (req, res) => {
    res.json({
      service: 'daily-video-automation',
      endpoints: ['GET /health', 'GET /status', 'GET /selftest', 'POST /run?date=YYYY-MM-DD', 'GET /cron', 'POST /cron'],
      ...publicConfig(),
    });
  });

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      istDate: dates.dateKey(),
      istTime: dates.timeOfDay(),
      running: pipeline.isRunning(),
      scheduler: config.schedule.enabled,
    });
  });

  app.get('/status', async (req, res) => {
    try {
      const all = await state.all();
      res.json({
        ok: true,
        config: publicConfig(),
        nextRun: scheduler.nextRun(),
        running: pipeline.isRunning(),
        lastRun,
        due: scheduler.plan(),
        state: all,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.all('/run', async (req, res) => {
    if (!authorised(req)) {
      res.status(401).json({ ok: false, error: 'unauthorised' });
      return;
    }
    const requested = (req.query.date || req.body.date || dates.dateKey()).toString();
    if (!dates.isValidKey(requested)) {
      res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' });
      return;
    }
    const force = String(req.query.force ?? req.body.force ?? '0') === '1';
    const upload = String(req.query.upload ?? req.body.upload ?? '1') === '1';
    // A full run takes minutes on a free instance and would outlast the proxy
    // timeout, so HTTP callers get an immediate ack and poll /status instead.
    const wait = String(req.query.wait ?? req.body.wait ?? '0') === '1';
    lastRun = { dateKey: requested, startedAt: new Date().toISOString(), force, mode: wait ? 'sync' : 'async' };

    if (pipeline.isRunning()) {
      res.status(409).json({ ok: false, error: 'a run is already in progress', lastRun });
      return;
    }

    if (!wait) {
      res.json({ ok: true, accepted: true, dateKey: requested, poll: '/status' });
      pipeline.runDate(requested, { force, upload })
        .then((result) => {
          lastRun = { ...lastRun, finishedAt: new Date().toISOString(), ok: true, result };
        })
        .catch((error) => {
          lastRun = { ...lastRun, finishedAt: new Date().toISOString(), ok: false, error: error.message };
        });
      return;
    }

    try {
      const result = await pipeline.runDate(requested, { force, upload });
      lastRun = { ...lastRun, finishedAt: new Date().toISOString(), ok: true, result };
      res.json({ ok: true, ...result });
    } catch (error) {
      lastRun = { ...lastRun, finishedAt: new Date().toISOString(), ok: false, error: error.message };
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/selftest', async (req, res) => {
    try {
      const report = await selftest.main();
      res.status(report.ok ? 200 : 500).json(report);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Called by an external scheduler (cron-job.org, UptimeRobot, GitHub Actions...)
  app.all('/cron', async (req, res) => {
    if (!authorised(req)) {
      res.status(401).json({ ok: false, error: 'unauthorised' });
      return;
    }
    try {
      const ran = await scheduler.tick('external-cron');
      res.json({ ok: true, istDate: dates.dateKey(), istTime: dates.timeOfDay(), ran });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'not found' });
  });

  app.use((error, req, res, next) => {
    log.error('Unhandled server error', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  });

  return app;
}

function start() {
  const app = create();
  const server = app.listen(config.api.port, '0.0.0.0', () => {
    log.info(`HTTP backend listening on :${config.api.port}`, {
      istDate: dates.dateKey(),
      istTime: dates.timeOfDay(),
      tts: (() => {
        try {
          return tts.resolveEngine();
        } catch {
          return 'unavailable';
        }
      })(),
    });
  });
  if (config.schedule.enabled) scheduler.start();
  else log.warn('Scheduler disabled (SCHEDULER_ENABLED=false) - drive it with /cron');
  return server;
}

module.exports = { create, start };