'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('./config');
const log = require('./log');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

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
  const parents = [];
  if (config.drive.folderId) parents.push(config.drive.folderId);
  parents.push('root');
  return parents;
}

/** Finds an existing file by exact name in the destination folder. */
async function findByName(name) {
  if (!config.drive.enabled) return null;
  const drive = await getDrive();
  const names = JSON.stringify([name]);
  const q = [`name = ${names}`, 'trashed = false'];
  if (config.drive.folderId) q.push(`'${config.drive.folderId}' in parents`);
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
    requestBody: { name, description, mimeType: 'application/json' },
    media: {
      mimeType: 'application/json',
      body: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'),
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
      body: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'),
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