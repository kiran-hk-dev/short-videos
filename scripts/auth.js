'use strict';

/**
 * One-time Google Drive authorisation for local/desktop use.
 * On Render use a service account instead (no browser is available there):
 * set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.
 */

const fs = require('fs');
const { google } = require('googleapis');
const readline = require('readline');
const config = require('../src/config');
const log = require('../src/log');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

async function main() {
  if (config.drive.serviceAccountEmail) {
    process.stdout.write('GOOGLE_SERVICE_ACCOUNT_EMAIL is set - nothing to authorise.\n');
    process.stdout.write('On a service-account setup the Drive folder must be shared with that account email.\n');
    return 0;
  }

  if (!fs.existsSync(config.paths.credentialsFile)) {
    process.stderr.write(`Missing ${config.paths.credentialsFile}\n`);
    process.stderr.write('Create an OAuth Client ID of type "Desktop app" in the Google Cloud console and save the JSON as credentials.json in the project root.\n');
    return 1;
  }

  const creds = JSON.parse(fs.readFileSync(config.paths.credentialsFile, 'utf8'));
  const section = creds.installed || creds.web;
  if (!section) {
    process.stderr.write('credentials.json does not look like a Google OAuth client file.\n');
    return 1;
  }

  const client = new google.auth.OAuth2(section.client_id, section.client_secret, section.redirect_uris);

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  process.stdout.write('\nOpen this URL, sign in, and approve Drive access:\n\n');
  process.stdout.write(`${url}\n\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = (await new Promise((resolve) => rl.question('Paste the redirect URL or the code: ', resolve))).trim();
  rl.close();

  const redirect = code.includes('://') ? code : `${(section.redirect_uris && section.redirect_uris[0]) || 'http://localhost'}?code=${code}`;
  const { tokens } = await client.getToken(redirect);
  fs.writeFileSync(config.paths.tokenFile, `${JSON.stringify(tokens, null, 2)}\n`);

  log.info('Token saved', { tokenFile: config.paths.tokenFile });
  process.stdout.write(`Saved ${config.paths.tokenFile}. Keep credentials.json and token.json private.\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    log.error('Authorisation failed', { error: error.message });
    process.exit(1);
  });