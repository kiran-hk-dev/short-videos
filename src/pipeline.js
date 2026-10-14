'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const dates = require('./dates');
const tools = require('./ffmpeg');
const storyStore = require('./story');
const tts = require('./tts');
const render = require('./render');
const background = require('./background');
const drive = require('./drive');
const state = require('./state');

let running = false;

function driveName(dateKey) {
  return `Daily-Short-${dateKey}.mp4`;
}

function alreadyExistsRemote(dateKey) {
  return drive.findByName(driveName(dateKey));
}

/**
 * Full run for one India-local calendar day.
 * Idempotent: reuses story/voice/mp4 and skips the upload when Drive already
 * has the file, so a crash mid-way never produces two videos.
 */
async function runDate(dateKey, opts = {}) {
  const { force = false, upload = config.upload } = opts;

  if (running) {
    log.info('Another run is already in progress, skipping this tick', { dateKey });
    return { skipped: true, reason: 'busy', dateKey };
  }

  running = true;
  const startedAt = Date.now();
  const result = { dateKey, uploaded: false, reused: false };
  let videoFile = null;

  try {
    await state.load();

    if (!force && await state.isCompleted(dateKey)) {
      const entry = state.get(dateKey);
      if (!upload || entry.remoteMissing !== true) {
        log.info('Date already completed, skipping', { dateKey, fileId: entry.fileId });
        return { ...result, skipped: true, reason: 'completed', dateKey };
      }
      log.info('Recorded upload is missing in Drive, retrying upload only', { dateKey });
    }

    log.info('Run started', { dateKey, upload, force });

    // 1. Story (cached on disk so a rerun keeps the same script).
    const storyPayload = await storyStore.getStory(dateKey, { force });
    const story = storyPayload.story;
    const narration = storyPayload.narration || storyStore.narrationText(story);

    // 2. Voice track.
    const audioFile = await tts.synthesize(narration, dateKey, { force });
    const audioSeconds = await tools.probeDurationSeconds(audioFile);

    // 3. Procedural cinematic background.
    const backgroundFile = background.ensureBackground(dateKey);

    // 4. Render (or reuse an existing render).
    const reusedMp4 = !force
      && fs.existsSync(path.join(config.paths.outputDir, `daily-short-${dateKey.replace(/-/g, '')}.mp4`));
    videoFile = await render.renderVideo({
      backgroundFile,
      audioFile,
      story,
      dateKey,
      duration: audioSeconds,
      force,
    });
    result.reused = reusedMp4;

    // 5. Upload.
    if (!upload) {
      log.info('Upload skipped (--no-upload)', { dateKey, videoFile });
      await state.set(dateKey, {
        status: 'rendered',
        videoFile: path.basename(videoFile),
        fileId: (state.get(dateKey) || {}).fileId || null,
      });
      return { ...result, skipped: true, reason: 'no-upload', videoFile };
    }

    let existing = await alreadyExistsRemote(dateKey);
    let fileId = (state.get(dateKey) || {}).fileId;
    if (existing && !force) {
      fileId = existing.id;
      log.info('Matching MP4 already in Drive, not uploading again', { dateKey, fileId });
      result.reused = true;
    } else {
      const uploaded = await drive.uploadFile({
        filePath: videoFile,
        name: driveName(dateKey),
        mimeType: 'video/mp4',
        description: `Daily vertical short for ${dates.human(dateKey)} (auto-generated, ${dates.timeOfDay()} ${config.timeZone})`,
      });
      fileId = uploaded.id;
      log.info('Uploaded to Drive', { dateKey, fileId });
    }
    result.uploaded = !result.reused;

    if (config.drive.uploadStory) {
      const storyRemoteName = `story-${dateKey}.json`;
      const found = await drive.findByName(storyRemoteName);
      if (!found) {
        const uploadedStory = await drive.uploadJson({
          name: storyRemoteName,
          data: storyPayload,
          description: `Story used for Daily-Short-${dateKey}.mp4`,
        });
        log.info('Story uploaded to Drive', { dateKey, fileId: uploadedStory.id });
      }
    }

    await state.set(dateKey, {
      status: 'completed',
      fileId: fileId || null,
      remoteName: driveName(dateKey),
      remoteMissing: false,
      videoFile: path.basename(videoFile),
      model: storyPayload.model,
      seconds: audioSeconds ? Math.round(audioSeconds) : null,
      durationSeconds: Date.now() - startedAt,
    });

    log.info('Run finished', {
      dateKey,
      fileId,
      uploaded: result.uploaded,
      totalSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
    return { ...result, fileId, videoFile };
  } catch (error) {
    log.error('Run failed', { dateKey, error: error.message });
    try {
      await state.set(dateKey, { status: 'failed', error: String(error.message).slice(0, 500) });
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    running = false;
  }
}

/** Generates the story only (useful for previewing scripts). */
async function storyOnly(dateKey, opts = {}) {
  const payload = await storyStore.getStory(dateKey, opts);
  return payload;
}

function isRunning() {
  return running;
}

module.exports = { runDate, storyOnly, isRunning, driveName };