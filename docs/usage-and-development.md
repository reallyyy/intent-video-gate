# Usage and Development Guide

Intent Video Gate is a local-first video gate for YouTube and Bilibili. It builds a mixed feed from your signed-in recommendations, asks Gemini to classify videos against your intent prompt, and only shows videos that pass.

## Requirements

- Node.js 20+
- Gemini CLI, authenticated as `gemini`
- `yt-dlp`
- Chromium or Brave for the extension
- Signed-in YouTube and Bilibili sessions in the browser profile used by the extension

The project has no npm dependencies. The scripts use Node.js built-in modules.

## Setup

```bash
git clone https://github.com/reallyyy/intent-video-gate.git
cd intent-video-gate
npm start
```

Open `http://127.0.0.1:47231`.

Load the extension:

1. Open Chromium or Brave.
2. Visit `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the repo's `extension/` directory.
6. Sign into YouTube and Bilibili in that same browser profile.

Run the dependency check:

```bash
npm run doctor
```

## Using the App

Write a filter prompt that describes what you want to watch. For example:

```text
Show serious history, economics, engineering, and science explainers. Avoid clickbait, gossip, low-effort reactions, and promotional AI slop.
```

Click refresh. The app will:

1. Read your filter and block keywords.
2. Collect YouTube and Bilibili candidates.
3. Remove keyword matches.
4. Ask Gemini to classify candidates.
5. Validate Bilibili subtitle availability for approved videos.
6. Translate eligible Chinese-only Bilibili subtitles.
7. Render a mixed approved feed.

Click Watch from the app. The extension creates a short-lived grant and opens the real YouTube or Bilibili watch page in the same tab. Direct browsing to platform feeds or unapproved videos is redirected back to the app.

## Bilibili Subtitle Rules

Bilibili videos must be usable in the focused watch experience.

Eligible Bilibili videos:

- Videos with downloadable English subtitles.
- Videos with downloadable bilingual subtitles.
- Chinese-only videos with downloadable Chinese subtitles that can be translated completely.
- Music videos or performances that Gemini explicitly labels `music-no-subtitles`.

Chinese-only videos have a 10-minute translation rule. If the Chinese subtitle timeline is longer than 600 seconds, the video is filtered out instead of being sent through Gemini translation. This keeps refreshes practical and avoids long, flaky translation jobs.

The translation cache stores source metadata:

- subtitle fingerprint
- source entry count
- source duration
- source end time

If a cached translation is stale, mismatched, partial, or too short for the current subtitle track, it is invalidated. The app will regenerate it when possible; otherwise the video is withheld from the feed.

## Extension Behavior

The extension has three jobs:

- enforce watch grants for YouTube and Bilibili navigation
- strip watch pages down to the native player
- render Bilibili stacked subtitles when the server has a valid translation

The Bilibili overlay anchors on the active English cue and merges the overlapping Chinese chunks. This keeps Chinese AI subtitle fragments from changing too quickly while the English sentence remains on screen.

## Configuration

Config and cache paths:

| Data | Default | Override |
| --- | --- | --- |
| Config | `~/.config/intent-video` | `INTENT_VIDEO_CONFIG_DIR` |
| Data | `~/.local/share/intent-video` | `INTENT_VIDEO_DATA_DIR` |

If those paths are not writable, the app falls back to `.intent-video/` in the project root.

Important config fields:

```jsonc
{
  "filter": "your intent prompt",
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

## Development

Run the full suite:

```bash
npm test
```

Run the local server:

```bash
npm start
```

Prepare a browser profile for live E2E tests:

```bash
npm run e2e-login
```

E2E tests use Chromium through the Chrome DevTools Protocol. They first check `CHROMIUM_DEBUG_URL`, then local ports such as `9222` and `9223`. If no DevTools endpoint is available, the helper starts Chromium or Brave with the extension loaded.

The local app must be reachable at `127.0.0.1:47231` for the main E2E flows. If it is not running, the test helper starts it with isolated fixture state.

Do not skip Chromium E2E tests because an app server or DevTools endpoint is missing. Fix the environment or let the helper launch the required browser.

## Useful Files

- `src/server.js`: feed pipeline, Bilibili subtitle policy, API endpoints
- `src/gemini.js`: Gemini prompts and response parsing
- `src/store.js`: config, cache, feed policy version, translation cache metadata
- `extension/content.js`: page cleanup, subtitle overlay, app-page sync
- `extension/subtitle-align.js`: Chinese/English subtitle cue alignment helper
- `test/server.test.js`: feed and subtitle policy coverage
- `test/chromium-bilibili-flow.test.js`: live Bilibili watch-page E2E coverage
