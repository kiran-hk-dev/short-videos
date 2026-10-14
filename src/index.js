'use strict';

const config = require('./config');
const log = require('./log');
const dates = require('./dates');
const pipeline = require('./pipeline');
const scheduler = require('./scheduler');
const server = require('./server');

function parseArgs(argv) {
  const args = {
    once: false,
    serve: false,
    schedulerOnly: false,
    storyOnly: false,
    force: false,
    upload: config.upload,
    date: null,
    backfill: 0,
    help: false,
  };

  for (const raw of argv) {
    const arg = raw.trim();
    if (arg === '--once') args.once = true;
    else if (arg === '--serve' || arg === '--start') args.serve = true;
    else if (arg === '--scheduler' || arg === '--schedule') args.schedulerOnly = true;
    else if (arg === '--story-only') args.storyOnly = true;
    else if (arg === '--force' || arg === '-f') args.force = true;
    else if (arg === '--no-upload') args.upload = false;
    else if (arg === '--upload') args.upload = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--date=')) args.date = arg.slice(7);
    else if (arg.startsWith('--backfill=')) args.backfill = Math.max(0, Number(arg.slice(11)) || 0);
  }

  return args;
}

function usage() {
  const rows = Object.entries(config.HELP).map(([flag, text]) => `  ${flag.padEnd(22)} ${text}`).join('\n');
  return [
    'Daily Video Automation',
    '',
    'Usage: node src/index.js [mode] [options]',
    '',
    rows,
    '',
    `Output: ${config.paths.outputDir}`,
    `Log:    ${config.paths.logFile}`,
    `Time zone: ${config.timeZone}`,
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const target = args.date && dates.isValidKey(args.date) ? args.date : dates.dateKey();
  if (args.date && !dates.isValidKey(args.date)) {
    log.error(`Ignoring invalid --date value "${args.date}" (expected YYYY-MM-DD)`);
  }

  if (args.storyOnly) {
    const payload = await pipeline.storyOnly(target, { force: args.force });
    process.stdout.write(`${payload.narration}\n\n(${payload.words} words, ${payload.model})\n`);
    return 0;
  }

  if (args.serve) {
    server.start();
    return null; // keep the process alive
  }

  if (args.schedulerOnly) {
    scheduler.start();
    await new Promise(() => {});
    return null;
  }

  // Default: single run (today, plus optional backfill).
  const keys = [target];
  for (let i = 1; i <= args.backfill; i += 1) keys.push(dates.shiftKey(target, -i));

  let failures = 0;
  for (const dateKey of keys) {
    try {
      const result = await pipeline.runDate(dateKey, { force: args.force, upload: args.upload });
      process.stdout.write(`${result.skipped ? 'skipped' : 'done'}: ${dateKey}\n`);
    } catch {
      failures += 1;
    }
  }

  log.close();
  return failures === 0 ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => {
      if (code !== null) process.exit(code);
    })
    .catch((error) => {
      log.error('Fatal', { error: error.message });
      log.close();
      process.exit(1);
    });
}

module.exports = { main, parseArgs };