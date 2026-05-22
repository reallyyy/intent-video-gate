# Intent Video Gate

A local-first, AI-gated video feed that merges YouTube and Bilibili recommendations into one curated list. You write a natural-language intent filter (e.g. "allow history documentaries and engineering explainers"), and Gemini classifies every candidate video as allowed or blocked. Only approved videos appear in the feed.

The browser extension prevents direct browsing of YouTube and Bilibili. When you click "Watch" on an approved video, the current tab navigates to the real signed-in watch page, stripped to a bare fullscreen player with native quality controls, subtitles, account history, and view tracking intact. No new tabs open.

## Features

- **Gemini AI classification** -- each video candidate is evaluated against your intent filter text. Fail-closed: if the AI is unreachable, nothing passes through.
- **Multi-platform feed** -- merges YouTube and Bilibili recommendations in a single page. YouTube comes from your signed-in recommendations via yt-dlp. Bilibili comes from the public API, yt-dlp, or cached suggestions.
- **Keyword blocklist** -- pre-AI keyword filter removes candidates by title, uploader, or tag before they ever reach Gemini. Managed from the web UI.
- **Bilibili stacked subtitles** -- Bilibili videos are eligible when the API reports usable English, bilingual, or Chinese AI subtitle tracks. Chinese-only subtitle tracks are translated server-side and rendered as a custom Chinese + English overlay on Bilibili watch pages.
- **Short-lived watch grants** -- clicking "Watch" creates a time-limited grant (5 minutes by default) for that exact URL. The extension checks grants before allowing any YouTube/Bilibili navigation. Unauthorized navigation is redirected back to the app.
- **Tune-out** -- every card has a "Tune out" button with two modes: manual (type a category to avoid) or AI-assisted (Gemini proposes clickable filter refinements based on the video's metadata).
- **Bilibili suggestion collection** -- the extension collects Bilibili recommendation cards from signed-in browsing and sends them to the app for the next feed refresh.
- **Watch history** -- every watch action is logged locally with metadata and timestamps.
- **Thumbnail proxy** -- Bilibili thumbnails (hdslb.com) are proxied through the local server to avoid CORS issues.
- **Zero runtime dependencies** -- everything uses Node.js built-in modules. No npm install step.

## Requirements

- **Node.js 20+**
- **Gemini CLI** -- the `gemini` command-line tool, authenticated. Install from [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli).
- **yt-dlp** -- for YouTube and Bilibili metadata extraction and recommendation crawling.
- **Chromium or Brave** -- the browser that runs the extension.

## Installation

```bash
git clone https://github.com/reallyyy/intent-video-gate.git
cd intent-video-gate
```

No `npm install` needed. The project has zero dependencies.

## Quick start

Start the local server:

```bash
npm start
```

Open http://127.0.0.1:47231 in the browser where the extension is loaded.

Check that `gemini` and `yt-dlp` are on PATH:

```bash
npm run doctor
```

The doctor endpoint is also available at http://127.0.0.1:47231/api/doctor.

## Browser extension

1. Open Chromium or Brave.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `extension/` directory from this project.
5. Sign into YouTube and Bilibili in that browser.

The extension intercepts all YouTube and Bilibili navigation, checks the local app for a valid watch grant, and either allows the navigation or redirects back to the app. On watch pages it strips everything except the player.

## Configuration

Config and data are stored in standard XDG-like directories:

| What | Default path | Override env var |
|------|-------------|-----------------|
| Config dir | `~/.config/intent-video` | `INTENT_VIDEO_CONFIG_DIR` |
| Data dir | `~/.local/share/intent-video` | `INTENT_VIDEO_DATA_DIR` |

If those directories are not writable, the app falls back to `.intent-video/` in the project root.

On first run the app writes `config.json` to the config directory with defaults. Edit it to change any setting. Key fields:

```jsonc
{
  "filter": "your intent filter text here",
  "port": 47231,
  "blockKeywords": ["warhammer", "sora"],
  "gemini": {
    "command": "gemini",
    "model": "gemini-3.1-flash-lite-preview",
    "fallbackModel": "gemini-3-flash-preview"
  },
  "suggestions": {
    "youtubeCookieBrowser": "chromium",
    "bilibiliCookieBrowser": "chromium",
    "feedSize": 20
  }
}
```

The `youtubeCookieBrowser` and `bilibiliCookieBrowser` fields are passed to yt-dlp's `--cookies-from-browser` flag. On first run the app auto-detects an installed browser (chromium, brave, google-chrome, or firefox). You can override with a browser name or `browser:/path/to/profile`.

## How it works

The system has two parts: a local HTTP server and a browser extension.

### Server

The Node.js server at http://127.0.0.1:47231 handles:

1. Reads your intent filter text and keyword blocklist.
2. Collects candidates from YouTube recommendations (via yt-dlp with browser cookies) and Bilibili (via yt-dlp, the Bilibili API, or cached suggestions from the extension).
3. Pre-filters Bilibili candidates by usable subtitle availability using the Bilibili API.
4. Pre-filters all candidates against the keyword blocklist.
5. Sends remaining candidates to Gemini in batches for AI classification.
6. If too few Bilibili videos pass, generates search queries via Gemini and searches Bilibili for more.
7. Selects the final mixed feed (up to 20 YouTube + a proportional slice of Bilibili).
8. Pre-translates Chinese-only Bilibili subtitle tracks and caches the approved feed for fast reloading.

### Extension

The Manifest V3 extension:

- **background.js** -- intercepts all YouTube and Bilibili navigation via `chrome.webNavigation.onBeforeNavigate`. Checks the local app for grant status, relays Bilibili cookies to the local server, and proxies Bilibili API requests from content scripts.
- **content.js** -- injected on YouTube, Bilibili, and the local app page. Hides masthead, sidebar, comments, and recommendations. Syncs translated subtitles, renders the Bilibili stacked subtitle overlay, collects Bilibili recommendation cards, and reports auth state.
- **focus.css** -- CSS that makes the player fill the viewport.

## API reference

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check, returns filter, keywords, auth, doctor status |
| GET | `/api/doctor` | Dependency check results |
| GET/PUT | `/api/filter` | Read or update intent filter text |
| GET/PUT | `/api/block-keywords` | Read or update keyword blocklist |
| GET | `/api/feed` | Get approved video feed (cached or fresh) |
| POST | `/api/watch` | Create a watch grant for a video |
| POST | `/api/filter/refine-video` | AI-assisted filter refinement for a specific video |
| POST | `/api/collect-bilibili` | Receive Bilibili suggestion cards from extension |
| GET | `/api/bilibili/thumbnail` | Proxy Bilibili thumbnails |
| GET | `/api/bilibili/subtitle-tracks` | Proxy Bilibili subtitle metadata with relayed cookies |
| GET | `/api/bilibili/subtitle-json` | Proxy Bilibili subtitle JSON downloads |
| GET | `/api/translated-subtitles` | Return cached translated subtitle entries for a Bilibili video |
| POST | `/api/bilibili-cookies` | Receive relayed Bilibili cookies from the extension |
| GET | `/api/navigation` | Classify a URL (allow/redirect/block) |
| POST | `/api/session` | Update auth state |

## Development

```bash
npm test              # unit + E2E tests
npm run doctor        # check dependencies
npm start             # start the server
npm run e2e-login     # launch browser for YouTube/Bilibili login
```

Tests use Node's built-in test runner (`node:test`). No test framework to install.

E2E tests launch a real Chromium instance with the extension loaded, seed the app with fixture data, and exercise the full flow through Chrome DevTools Protocol. If no DevTools endpoint is found, the test helper starts one.

### E2E login setup

Bilibili stacked subtitle tests require a logged-in browser profile. Run the login helper to detect your browser profile or create one:

```bash
npm run e2e-login
```

If you already have a browser profile logged into YouTube and Bilibili (e.g. your regular Chromium profile), point the tests directly at it:

```bash
INTENT_VIDEO_E2E_PROFILE=~/.config/chromium npm test
```

On systems where Chromium is installed via Snap, the profile is typically at `~/snap/chromium/common/chromium`. The login helper auto-detects this.

## License

MIT
