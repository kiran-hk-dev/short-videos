'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { google } = require('googleapis');
const config = require('./config');
const log = require('./log');

/**
 * The full Drive scope is required here, not the narrower `drive.file`.
 * `drive.file` only exposes files this app created, so a folder that is merely
 * *shared* with the service account stays invisible and uploads fail with
 * "File not found". A service account only ever sees what was shared with it,
 * so the wider scope is still limited to that one folder in practice.
 * Override with GOOGLE_SCOPES if you want something else.
 */
const SCOPES = (process.env.GOOGLE_SCOPES
  || 'https://www.googleapis.com/auth/drive').split(',').map((s) => s.trim()).filter(Boolean);

let cachedDrive = null;
let cachedAuthKind = null;

function privateKeyFromEnv() {
  const raw = config.drive.serviceAccountPrivateKey;
  if (!raw) return null;
  // Render env vars keep the PEM with literal \n sequences.
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

function authDescription() {
  if (config.drive.serviceAccountEmail) return 'service-account';
  if (fs.existsSync(config.paths.credentialsFile)) return 'oauth-desktop';
  return 'none';
}

async function getDrive() {
  if (cachedDrive) return cachedDrive;

  const email = config.drive.serviceAccountEmail;
  const privateKey = privateKeyFromEnv();
  if (email && privateKey) {
    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: email, private_key: privateKey },
      scopes: SCOPES,
    });
    cachedDrive = google.drive({ version: 'v3', auth });
    cachedAuthKind = 'service-account';
    log.info('Drive auth: service account', { email });
    return cachedDrive;
  }

  if (fs.existsSync(config.paths.credentialsFile)) {
    const creds = JSON.parse(fs.readFileSync(config.paths.credentialsFile, 'utf8'));
    const client = new google.auth.OAuth2(
      creds.installed ? creds.installed.client_id : creds.web.client_id,
      creds.installed ? creds.installed.client_secret : creds.web.client_secret,
      creds.installed ? creds.installed.redirect_uris : creds.web.redirect_uris,
    );
    if (fs.existsSync(config.paths.tokenFile)) {
      client.setCredentials(JSON.parse(fs.readFileSync(config.paths.tokenFile, 'utf8')));
    }
    cachedDrive = google.drive({ version: 'v3', auth: client });
    cachedAuthKind = 'oauth-desktop';
    log.info('Drive auth: desktop OAuth token', { tokenFile: path.basename(config.paths.tokenFile) });
    return cachedDrive;
  }

  throw new Error(
    'Google Drive is not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY '
    + '(Render) or place credentials.json and run `npm run auth` (local).',
  );
}

function authKind() {
  return authDescription();
}

function parentArgs() {
  const id = folderId();
  return id ? [id, 'root'] : ['root'];
}

/**
 * Accepts either a bare folder ID or a full Drive folder URL, so a pasted
 * link still works. Falls back to the service account's root with a warning.
 */
function folderId() {
  const raw = (config.drive.folderId || '').trim();
  if (!raw) return '';
  const match = raw.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (match) return match[1];
  if (raw.includes('/') || raw.includes('?')) {
    log.warn('GOOGLE_DRIVE_FOLDER_ID looks like a URL and could not be parsed - using Drive root');
    return '';
  }
  return raw;
}

/** Drive's q syntax wants single quotes; double quotes cause "Invalid Value". */
function driveQuote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Finds an existing file by exact name in the destination folder. */
async function findByName(name) {
  if (!config.drive.enabled) return null;
  const drive = await getDrive();
  const q = [`name = ${driveQuote(name)}`, 'trashed = false'];
  const id = folderId();
  if (id) q.push(`${driveQuote(id)} in parents`);
  const res = await drive.files.list({
    q: q.join(' and '),
    fields: 'files(id,name,size,modifiedTime,webViewLink)',
    spaces: 'drive',
    pageSize: 5,
  });
  const files = res.data.files || [];
  return files[0] || null;
}

async function uploadFile({ filePath, name, mimeType, description }) {
  const drive = await getDrive();
  const fileName = name || path.basename(filePath);
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      description,
      mimeType,
      parents: parentArgs(),
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id,name,size,webViewLink',
  });
  return res.data;
}

async function uploadJson({ name, data, description }) {
  const drive = await getDrive();
  const res = await drive.files.create({
    requestBody: { name, description, mimeType: 'application/json', parents: parentArgs() },
    media: {
      mimeType: 'application/json',
      // googleapis needs a stream, not a Buffer, for media bodies.
      body: Readable.from([Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8')]),
    },
    fields: 'id,name,size',
  });
  return res.data;
}

async function downloadJson(fileId) {
  const drive = await getDrive();
  const res = await drive.files.get({ fileId, alt: 'media' });
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  return JSON.parse(text);
}

async function updateJson(fileId, data) {
  const drive = await getDrive();
  await drive.files.update({
    fileId,
    media: {
      mimeType: 'application/json',
      body: Readable.from([Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8')]),
    },
    fields: 'id,name,modifiedTime',
  });
}

function reset() {
  cachedDrive = null;
  cachedAuthKind = null;
}

module.exports = {
  SCOPES,
  getDrive,
  authKind,
  parentArgs,
  findByName,
  uploadFile,
  uploadJson,
  downloadJson,
  updateJson,
  reset,
};