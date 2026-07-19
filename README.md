# anyjob

Crawl job postings and AI-fill applications — you review and click submit yourself.

**Design principle: this tool never submits an application for you.** It logs in with your
real credentials (never session cookies), scrapes postings, fills the application form using
an LLM to map your resume/profile onto the form fields, then stops and leaves the browser
window open for you to review and hit Submit.

## How it's organized

- `src/llm/provider.ts` — `chatStructured()` with two transports, selected via `LLM_TRANSPORT`:
  - `openai` (default) — any OpenAI-compatible `/chat/completions` endpoint with structured
    (JSON-schema) output. Point it at OpenAI, Cerebras, NVIDIA NIM, a local Ollama/vLLM server,
    or anything else that speaks the same API shape — just change `LLM_BASE_URL` / `LLM_MODEL` /
    `LLM_API_KEY`.
  - `anyapi-daemon` — routes through a locally running [anyapi](/root/myai/anyapi) daemon
    instead (e.g. DeepSeek's free web chat, automated via Playwright) via
    `src/llm/anyapiDaemonClient.ts` + `scripts/anyapi_bridge.py`. No API key needed, but you
    must start the daemon yourself first (see below) and it has no native structured-output
    support, so the JSON schema is described in the prompt instead of sent as `response_format`.
- `src/sites/adapter.ts` — the `JobSiteAdapter` interface every site plugs into: `login`,
  `scrapeListings`, `scrapeJobDetail`, `fillApplication`.
  - `src/sites/workday/workdayAdapter.ts` — Workday-hosted career sites (credential login,
    session cached via Playwright storageState).
  - `src/sites/greenhouse/greenhouseAdapter.ts` — Greenhouse job boards (public, no login).
- `src/apply/formFields.ts` — generic DOM form scanner + the LLM call that maps your profile
  onto scanned fields + the shared fill/screenshot logic every adapter uses.
- `src/storage/db.ts` — flat-file job store at `data/jobs.json` (scraped/filled/applied status).
- `src/cli.ts` — the `login` / `crawl` / `list` / `parse-resume` / `apply` commands.
- `shared-browser/formUtils.js` — the DOM form-scanning/filling heuristic, as plain vanilla JS
  so the exact same code runs in both Playwright (`extractFormFields` loads and evaluates this
  file) and the browser extension (see below) — one implementation, not two that can drift.
- `src/server.ts` + `extension/` — a Chrome extension alternative to the Playwright `apply`
  flow: fill applications in your own already-logged-in browser tab instead. See "Browser
  extension" below.

## Setup

```bash
npm install
npx playwright install chromium   # downloads the browser binary Playwright drives
cp .env.example .env               # fill in your LLM + site credentials
```

Never put session cookies in `.env` — only your normal login username/password, which
Playwright uses to drive a real login form. Credentials stay local; nothing is sent anywhere
except the site itself and your chosen LLM provider.

### Using DeepSeek via anyapi instead of an API key

Set `LLM_TRANSPORT=anyapi-daemon` in `.env` (see `.env.example`), then start the daemon
separately before running any anyjob command that calls the LLM (`parse-resume`, `apply`):

```bash
cd /root/myai
pip install -e .
playwright install chromium
chmod 600 deepseek_cookies.json deepseek_localstorage.json   # anyapi refuses group/world-readable auth files
anyapi-daemon --provider deepseek --cookies /root/myai/deepseek_cookies.json --localstorage /root/myai/deepseek_localstorage.json
```

Leave that running in its own terminal — it's the thing anyjob's `chatStructured()` talks to
over `~/.local/share/anyapi/deepseek_daemon.sock`. The cookies/localstorage come from a real
logged-in `chat.deepseek.com` browser session (see `/root/myai/DEEPSEEK_AUTOMATION.md`) and can
expire; if the bridge starts erroring, re-export them and restart the daemon.

This path is inherently more fragile than a real API key (it's scraping a chat UI, not calling
a REST endpoint), so prefer the `openai` transport with a real DeepSeek/OpenAI/Cerebras/etc. API
key for anything you care about running reliably.

**`npm run start-all` does the manual steps above for you** — starts the daemon (only if
`.env` has `LLM_TRANSPORT=anyapi-daemon`) and the local server (see "Browser extension" below),
skipping anything already running instead of erroring, and syncs the extension's copy of
`shared-browser/formUtils.js`. Prints the extension token when done. `npm run stop-all` shuts
down anything it started (tracked via `data/*.pid`) — it won't touch a server/daemon you
started yourself outside this script.

## Usage

```bash
# 1. One-time: parse your resume into a structured profile (data/profile.json)
npm run parse-resume -- ./data/resume.pdf

# 2. Log in once per site; session is cached so you don't repeat this every run
npm run login -- workday:asu

# 3. Crawl postings into data/jobs.json
npm run crawl -- workday:asu "https://www.myworkday.com/asu/d/task/1422$3898.htmld" --detail

# 4. See what's stored
npm run cli -- list --site workday:asu --status scraped

# 5. AI-fill one application — opens a real (non-headless) browser, fills the form,
#    and waits. Review the screenshot in data/screenshots/ or the live window, then
#    click Submit yourself in the browser.
npm run apply -- workday:asu <jobId>
```

Site keys are `<adapterType>:<name>`, e.g. `workday:asu` or `greenhouse:acme`. Credentials
for a Workday site key `workday:asu` come from `WORKDAY_ASU_URL` / `WORKDAY_ASU_USERNAME` /
`WORKDAY_ASU_PASSWORD` in `.env`.

## Browser extension (fill applications in your own logged-in tab)

An alternative to the Playwright `apply` flow: instead of automating a separate Chromium
instance with credentials Playwright drives itself, this extension runs in a real browser tab
you're already logged into — so it never needs Workday/site credentials or Playwright login at
all. It only ever fills the form; you still click Submit yourself.

The UI lives in Chrome's **side panel** (`chrome.sidePanel`), not a popup — it stays docked
open on the side of the window across tab navigation instead of closing every time you click
away, so you can browse to a form and fill it without reopening anything.

**How it's wired:** the side panel (`extension/sidepanel.html`/`.js`) injects
`shared-browser/formUtils.js` (copied into `extension/shared/`) into the active tab to scan
labeled form fields, relays them through the extension's background service worker to a small
local HTTP server (`src/server.ts`), which calls the same `mapProfileToFields` used by the CLI,
then the panel fills the DOM directly and highlights each field green (filled) or red (needs
your input) — never touching Submit.

### Setup

```bash
npm run start-all   # starts the local server (+ the DeepSeek daemon if configured), prints a token
```

Then in Chrome: go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
and select the `extension/` folder. Click the extension's toolbar icon — the side panel opens
and docks to the side of the window. Paste in the token `start-all` printed (also saved at
`data/extension-token.txt`), and click **Save token**.

Run `npm run stop-all` when you're done to shut down what `start-all` started. Both scripts are
safe to re-run — `start-all` skips anything already running, `stop-all` only stops what it
started itself (tracked via `data/*.pid`), so it won't kill a server you're running some other
way.

### Usage

1. Make sure you've run `npm run parse-resume` at least once (the server needs `data/profile.json`).
2. Click the extension icon once to open the side panel — it stays docked open from here on,
   even as you navigate between tabs/pages.
3. Navigate to a job application form in your normal, already-logged-in browser tab.
4. In the still-open side panel, click **Scan & Fill This Page**.
5. Review the highlighted fields (green = filled, red = needs your input — hover for why) and
   submit yourself.

The panel's **Log** box shows live progress as it happens — including the AI's answer
streaming in token-by-token when using the `anyapi-daemon` transport — rather than a silent
wait. If something fails, the log and status line show exactly which stage failed (scanning,
reaching the server, the LLM call itself, or parsing its JSON reply) and the actual underlying
error message, not just a generic failure.

**Partial failures don't cost you the whole form.** `mapProfileToFields` (`src/apply/formFields.ts`)
tries one efficient request for every field first, retries once on failure, and only then falls
back to mapping fields one at a time — so a single flaky daemon call costs you at most the
fields it touched, not the entire application. Each field that still fails after its own retry
shows up individually in the result with the real error as the reason, instead of the whole
fill aborting.

The server binds to `127.0.0.1` only and requires the token on every request — without that,
any website you visit could otherwise probe a local HTTP server listening on your machine.
If you're using the `anyapi-daemon` LLM transport, remember it can only handle one request at a
time (it's driving a single shared browser session) — don't click "Scan & Fill" again until the
previous one finishes.

If you edit `shared-browser/formUtils.js`, re-run `npm run sync-extension` and reload the
extension in `chrome://extensions` to pick up the change.

## Adding a new site

Implement `JobSiteAdapter` (see the Workday/Greenhouse adapters for reference) and register
it in `getAdapter()` in `src/cli.ts`. The form-fill step (`extractFormFields` +
`mapProfileToFields` + `fillAndScreenshot` from `src/apply/formFields.ts`) is generic enough
to reuse as-is for most sites; you'll mainly need to write `login`, `scrapeListings`, and
`scrapeJobDetail` for the new site's DOM structure.

## What this deliberately does NOT do

- Never accepts or replays session cookies — only real credential-based login.
- Never clicks the final Submit button — `fillAndScreenshot` stops right before that, always.
- Never invents facts on the application — the LLM is instructed to leave a field in
  `unmapped` (surfaced to you in the CLI output) rather than guess when the profile doesn't
  have an answer.
- The extension never auto-submits either, and its local server only ever answers requests
  carrying the token you set yourself — it isn't an open door for other sites on your machine.
