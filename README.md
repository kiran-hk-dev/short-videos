# Free Daily Video Automation (server / backend)

One vertical MP4 per India-local calendar day, generated and uploaded by a **single free cloud
service**: a free (or local) LLM writes the story, free TTS reads it, FFmpeg renders an animated
cinematic frame over a procedurally generated starfield background, and the result lands in Google
Drive. No paid API is involved anywhere.

The repo is a plain Node.js HTTP service with a Dockerfile, so it deploys unchanged to **Render**,
**Koyeb**, **Railway**, **Google Cloud Run**, Fly.io, or any VPS that runs containers.

## Pipeline

For a target date (India-local, `YYYY-MM-DD`):

1. **Story** — Ollama (`llama3.2:3b`) returns JSON: title, hook, 3–4 points. If Ollama is unset or
   unreachable, a deterministic offline writer produces a themed script instead, so the daily job never
   fails just because a model is missing. Free 512 MB instances should leave `OLLAMA_BASE_URL` empty.
2. **Voice** — `piper` (if a voice model is set), else `espeak-ng` (bundled in the image), else `gTTS`.
3. **Background** — a procedural 1080×1920 PNG (three-stop gradient, seeded starfield, vignette, baked
   bottom scrim) generated in pure Node with `zlib`: no image assets, no image API.
4. **Render** — FFmpeg slow zoom-push over the still, staggered text reveals, growing accent rule,
   progress bar, fade in/out, H.264 + AAC.
5. **Upload** — `Daily-Short-YYYY-MM-DD.mp4` (plus `story-YYYY-MM-DD.json`) into your Drive folder.
6. **Ledger** — the date is recorded in `daily-state.json` **inside the Drive folder**, because a free
   instance's disk is wiped on every redeploy. A date that is already completed is never regenerated.

## Free hosting: what to pick

| Host | Free tier | How this repo runs there | Wakes itself up? |
| --- | --- | --- | --- |
| **Render** (recommended) | Free web service, 512 MB, spins down when idle | Blueprint via `render.yaml` | No built-in free cron — use GitHub Actions or a pinger |
| **Koyeb** | Free web service, 512 MB, sleep after 1 h | Dockerfile (auto-detected), port 8000 | No free cron — same workaround |
| **Railway** | $5 trial credit | Dockerfile, `PORT` env | Credit-based; not truly free long term |
| **Google Cloud Run** | 2M requests/month free, scales to zero | `gcloud builds submit` + deploy | Yes, via Cloud Scheduler (3 free jobs) or an external ping |
| **Oracle Cloud Always Free** | Always-free VM, real cron | Docker Compose or systemd | Yes, native `cron` |
| Fly.io / DigitalOcean | no free tier / trial only | Dockerfile | – |

Pick Render or Koyeb for the least work, then add the free GitHub Actions trigger in
[Keeping the service awake](#keeping-the-service-awake).

## Deploy on Render

1. Push this folder to a GitHub repository. `.gitignore` already excludes `node_modules/`, `output/`,
   `logs/`, `.env`, `credentials.json`, `token.json`.
2. Render → **New** → **Blueprint** → select the repository (it reads `render.yaml`), or **New** →
   **Web Service** → connect the repo. The `Dockerfile` is used automatically
   (`node:22-slim` + `ffmpeg` + `espeak-ng` + `fonts-dejavu-core`).
3. Settings:

   | Setting | Value |
   | --- | --- |
   | Instance type | Free |
   | Region | Singapore (closest to India) |
   | Health check path | `/health` |

4. Environment variables:

   | Variable | Value |
   | --- | --- |
   | `API_TOKEN` | long random string — required by `/run` and `/cron` |
   | `TZ_NAME` | `Asia/Kolkata` |
   | `SCHEDULE_HOUR` / `SCHEDULE_MINUTE` | `15` / `42` |
   | `SCHEDULER_ENABLED` | `true` |
   | `CATCH_UP_DAYS` | `1` — fill yesterday if a day was missed, `0` disables |
   | `OLLAMA_BASE_URL` | empty on the free tier |
   | `GOOGLE_DRIVE_FOLDER_ID` | the Drive folder that receives videos |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | service account e-mail (below) |
   | `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | full PEM key; `\n` escapes are fine |
   | `STORY_THEME` | `motivation`, `finance`, `health`, `focus` or `gratitude` |
   | `CHANNEL_NAME` | footer text |
   | `ACCENT_COLOR` | e.g. `#E8B44A` |

   Generate a token:

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

5. Deploy, then check:

   ```bash
   curl https://<service>.onrender.com/health
   curl https://<service>.onrender.com/status
   ```

   `/status` shows the effective config, the next scheduled run, what is due, and the full ledger.

## Google Drive from a server

A server cannot open a browser for OAuth, so use a **service account**:

1. Google Cloud console → create/select a project → enable **Google Drive API**.
2. **IAM & Admin → Service Accounts** → create one → **Keys** → **Add key** → JSON. Copy the
   `client_email` and `private_key`.
3. In Google Drive, create the destination folder (e.g. `Daily Shorts`).
4. Share that folder with the service account e-mail (Viewer is enough to add files to a folder shared
   with it) and copy the folder ID from the folder URL: `…/folders/<FOLDER_ID>`.
5. Set `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_DRIVE_FOLDER_ID`.

Only the `drive.file` scope is used. `npm run auth` (desktop OAuth) still exists if you ever run the
service on a laptop, but it is not needed on a server.

## Keeping the service awake

Free instances sleep when idle and their own cron is either paid (Render) or absent (Koyeb), so an
outside signal does the job. Every request wakes the instance; when it wakes, the in-process scheduler
sees that today's slot has passed and runs whatever date is still missing. Duplicate work is
impossible — the Drive ledger decides.

**Option A — GitHub Actions (free, included).** `.github/workflows/daily-trigger.yml` is in the repo.
Add two repository secrets (Settings → Secrets and variables → Actions):

* `APP_URL` — `https://<service>.onrender.com`
* `API_TOKEN` — the same token as in the environment

It calls `POST <APP_URL>/cron?token=<API_TOKEN>` at 19:05 IST and again at 23:15 IST as a safety net,
and can also be triggered manually with **Run workflow**. Scheduled workflows are delayed by a few
minutes when the repo has little activity — the second run covers that.

**Option B — a free monitor.** cron-job.org or UptimeRobot, job every 5–10 minutes:

```
https://<service>.onrender.com/cron?token=<API_TOKEN>
```

Both wake the instance and let it decide whether anything is due.

**Option C — Google Cloud Run + Cloud Scheduler.** Deploy the same image with Cloud Scheduler (3 free
jobs) hitting the URL; the service scales to zero between runs and costs nothing.

**Manual trigger, any time:**

```bash
curl -X POST "https://<service>/run?token=<API_TOKEN>"
curl -X POST "https://<service>/run?token=<API_TOKEN>&date=2026-10-14&force=1"
```

## HTTP API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness, IST date/time, whether a run is in progress |
| `GET` | `/selftest` | none | Fast probe of every stage: ffmpeg/ffprobe, font, TTS engine, real cgroup memory/CPU limits, Drive auth + folder read/write access, files already in the folder |
| `GET` | `/files` | token | List what this container has produced (MP4 size + duration, story, audio) with download links |
| `GET` | `/files/:name` | token | Download one artefact from the container (`/files/daily-short-20261015.mp4?token=…`) |
| `GET` | `/status` | none | Config summary, next run, due dates, full ledger |
| `POST` | `/run` | token | Run one date. Query/body: `date=YYYY-MM-DD`, `force=1`, `upload=0`, `wait=1` |
| `POST` | `/run` | token | Run one date. Query/body: `date=YYYY-MM-DD`, `force=1`, `upload=0` |
| `GET`/`POST` | `/cron` | token | Run whatever is due right now (use this for external crons) |

`POST /run` returns immediately (`{"accepted":true}`) and works in the background, because a full render
outlasts the proxy timeout on a free instance; poll `/status` for the result. Add `wait=1` to block until
the run finishes.

Send the token as `x-api-token: <token>`, `Authorization: Bearer <token>` or `?token=<token>`.
`GET /` returns a short index of these endpoints. If `API_TOKEN` is left empty, `/run` and `/cron`
accept unauthenticated requests — set `ALLOW_OPEN_CRON=false` to close `/cron` too.

## Configuration

Everything is environment variables; `.env.example` is the annotated reference.

| Group | Keys |
| --- | --- |
| Schedule | `TZ_NAME`, `SCHEDULE_HOUR`, `SCHEDULE_MINUTE`, `SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_MINUTES`, `CATCH_UP_DAYS` |
| Story | `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`, `STORY_THEME`, `STORY_WORDS` |
| TTS | `TTS_ENGINE`, `PIPER_VOICE`, `GTTS_LANG` |
| Render | `WIDTH`, `HEIGHT`, `FPS`, `CRF`, `PRESET`, `ZOOM_RATE`, `ACCENT_COLOR`, `CHANNEL_NAME`, `FONT_PATH`, `ENABLE_GRAIN`, `MAX_AUDIO_SECONDS` |
| Drive | `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `UPLOAD_STORY`, `DRIVE_ENABLED` |
| Service | `PORT`, `API_TOKEN`, `ALLOW_OPEN_CRON`, `OUTPUT_DIR`, `LOG_FILE`, `STATE_FILE`, `FFMPEG_PATH`, `FFPROBE_PATH` |

`TTS_ENGINE=auto` resolves to `piper` (if `PIPER_VOICE` is set and `piper` is on PATH) → `espeak-ng`
→ `gTTS`. Force one with `TTS_ENGINE=piper|espeak|gtts`.

If you want LLM-written scripts on a free instance, point `OLLAMA_BASE_URL` at any Ollama host you can
reach (another machine, or a bigger free box). A 3B model needs ~3 GB RAM, so not on a 512 MB free
service — there the offline writer takes over automatically and the job still completes.

## Duplicate prevention and retries

* A completed date is stored in `daily-state.json` in the Drive folder (and mirrored to
  `logs/completed.json`), so redeploys and spin-downs cannot re-generate a day.
* Before uploading, the app looks for `Daily-Short-YYYY-MM-DD.mp4` in the destination folder. If Drive
  already has it, that file ID is recorded instead of uploading again — this closes the window where an
  upload succeeds but the process dies before writing state.
* Story JSON, voice track, background PNG and MP4 are reused on a rerun, so a failure at the upload
  step retries with the identical video instead of a new variation.
* Failed dates are stored with `status: failed` and retried on the next tick. `force=1` re-renders and
  re-uploads even a completed date.
* `CATCH_UP_DAYS=1` lets a service that was down overnight produce yesterday's video; a brand-new
  installation with no history never backfills.

## Troubleshooting

* **`ffmpeg failed: spawn ffmpeg ENOENT`** — the image includes ffmpeg; on non-Docker hosts set
  `FFMPEG_PATH` / `FFPROBE_PATH`. `npm run doctor` prints what it finds.
* **`No such filter`** — the renderer needs `zoompan`, `drawtext` (with `fontfile`), `drawbox`, `fade`;
  FFmpeg 4.4+ is fine.
* **Blank or garbled titles** — set `FONT_PATH` to a TTF file present in the image
  (`/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`).
* **Instance keeps restarting / job killed mid-render** — free instances are CPU-throttled; lower
  `WIDTH`/`HEIGHT` to `720`/`1280` or `CRF` to `28`, and check the Render dashboard for out-of-memory
  events.
* **Nothing happens at 19:00** — the free instance was asleep and nothing pinged it. Add the GitHub
  Actions trigger or a cron-job.org monitor, then confirm with `GET /status` that `nextRun` and `due`
  look right.
* **Drive permission errors** — confirm the folder is shared with the service account e-mail and that
  `GOOGLE_DRIVE_FOLDER_ID` is the folder id, not the full URL.
* **Robotic voice** — that is `espeak-ng`, the free offline default. Install `piper` in the image (see
  the commented block in `Dockerfile`) and set `PIPER_VOICE`, or use `TTS_ENGINE=gtts`.
* **Video too large** — raise `CRF` (26 → 28) or drop the resolution.

## Commands

```bash
npm install
npm run doctor          # environment check (node, ffmpeg, ffprobe, font, TTS, Ollama, Drive)
npm run auth            # optional: desktop OAuth, only if running outside a server
npm start               # HTTP backend + scheduler (what the hosts run)
npm run video           # one run now, uploads to Drive
npm run video -- --no-upload
npm run video -- --date=2026-10-14
npm run story           # script only, no video
npm run schedule        # scheduler loop without HTTP
node src/index.js --backfill=2 --no-upload
```

## Limitations

* The visual is a procedural motion graphic (gradient, stars, slow zoom, typography) — not photoreal
  AI footage, and no image/video generation service is used.
* Voice quality depends on the engine: `espeak-ng` is robotic but free and offline, `gtts` needs
  network access, `piper` is the best free option if you add it to the image.
* A local LLM can still write an inaccurate script. Review early videos and adjust `STORY_THEME`,
  `STORY_WORDS`, or the prompt in `src/story.js`.
* Rendering is CPU-bound: about 10 s of CPU for 25 s of 1080×1920 video, several minutes on a
  throttled free instance.# short-videos
