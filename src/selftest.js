'use strict';

/**
 * Fast, side-effect-free environment probe: reports every stage of the
 * pipeline so a failed daily run can be diagnosed without reading logs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const tools = require('./ffmpeg');
const config = require('./config');
const render = require('./render');
const tts = require('./tts');
const drive = require('./drive');
const system = require('./system');

function disk() {
  try {
    const stat = fs.statfsSync(config.paths.outputDir);
    return {
      totalMB: Math.round((stat.blocks * stat.bsize) / 1048576),
      freeMB: Math.round((stat.bavail * stat.bsize) / 1048576),
    };
  } catch {
    return null;
  }
}

function hasBin(name) {
  for (const dir of (process.env.PATH || '').split(require('path').delimiter).filter(Boolean)) {
    try {
      if (fs.existsSync(require('path').join(dir, name))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch (error) {
    return `no: ${error.message}`;
  }
}

async function main() {
  const report = {
    ok: true,
    container: {
      platform: `${os.platform()} ${os.arch()}`,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      cpus: os.cpus().length,
      hostMemoryMB: Math.round(os.totalmem() / 1048576),
      memoryFreeMB: Math.round(os.freemem() / 1048576),
      // What this container is actually allowed to use (free tier = ~512 MB).
      memoryLimitMB: system.memoryLimitMB(),
      cpuLimit: system.cpuLimit(),
    },
    disk: disk(),
    paths: {
      outputDir: config.paths.outputDir,
      outputWritable: writable(config.paths.outputDir),
      logFile: config.paths.logFile,
    },
    binaries: {},
    font: render.findFont() || null,
    renderPlan: render.plan(),
    tts: { requested: config.tts.engine },
    drive: { authKind: drive.authKind() },
  };

  for (const tool of await tools.check()) {
    report.binaries[tool.name] = tool.ok ? { ok: true, path: tool.path } : { ok: false, error: tool.error };
  }

  try {
    report.tts.engine = tts.resolveEngine();
    report.tts.ok = true;
  } catch (error) {
    report.tts.ok = false;
    report.tts.error = error.message;
  }
  report.tts.espeakAvailable = hasBin('espeak-ng') || hasBin('espeak');
  report.tts.piperAvailable = hasBin('piper');
  report.tts.piperVoice = config.tts.piperVoice || null;

  if (config.drive.enabled) {
    try {
      const client = await drive.getDrive();
      const folderId = (config.drive.folderId || '').match(/\/folders\/([A-Za-z0-9_-]{10,})/)?.[1]
        || config.drive.folderId || '';
      if (folderId) {
        const folder = await client.files.get({ fileId: folderId, fields: 'id,name', supportsAllDrives: true });
        report.drive.folder = { id: folderId, name: folder.data.name, readable: true };
        const inside = await client.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'files(id,name,size)',
          pageSize: 5,
        });
        report.drive.fileCount = (inside.data.files || []).length;
        report.drive.recentFiles = (inside.data.files || []).map((f) => `${f.name} (${f.size || 0}b)`);

        // Write probe: proves the service account can actually add files.
        try {
          const probeName = `.write-probe-${Date.now()}.txt`;
          const probe = await client.files.create({
            requestBody: { name: probeName, parents: [folderId] },
            media: { mimeType: 'text/plain', body: Readable.from([Buffer.from('ok')]) },
            fields: 'id',
          });
          await client.files.delete({ fileId: probe.data.id });
          report.drive.canWrite = true;
        } catch (error) {
          report.ok = false;
          report.drive.canWrite = false;
          report.drive.writeError = String(error.message).split('\n').slice(0, 3).join(' | ');
          report.drive.hint = 'Upload was rejected. Share the folder with the service account as '
            + '"File creator", "Editor" or "Writer" - Viewer cannot add files.';
        }
      } else {
        report.drive.folder = { readable: false, note: 'GOOGLE_DRIVE_FOLDER_ID is empty' };
      }
    } catch (error) {
      report.ok = false;
      report.drive.error = String(error.message).split('\n')[0];
      report.drive.hint = 'A service account can only write into a folder that is shared with it '
        + '(role: File creator or Writer). Check GOOGLE_DRIVE_FOLDER_ID and the folder share.';
      // Show what this service account can actually see, to separate
      // "wrong folder id" from "no access at all".
      try {
        const visible = await client.files.list({
          q: 'trashed = false',
          fields: 'files(id,name,mimeType)',
          pageSize: 10,
          orderBy: 'modifiedTime desc',
        });
        report.drive.visibleToServiceAccount = (visible.data.files || []).map((f) => `${f.name} [${f.mimeType.split('/').pop()}]`);
      } catch {
        report.drive.visibleToServiceAccount = 'could not list files';
      }
    }
  }

  return report;
}

module.exports = { main };