# Bilibili Stacked Subtitle Overlay — Handoff Document

## Goal

Bilibili videos only have Chinese AI subtitles (`ai-zh`). The feature adds stacked Chinese + English subtitle overlays to Bilibili video pages via a custom `<div>` overlay rendered by the extension's content script.

## Architecture

```
User's browser (Chromium/Brave)
  └─ extension/background.js
       ├─ chrome.cookies.getAll → bilibili cookies
       ├─ POST /api/bilibili-cookies → server gets auth cookies
       └─ onInstalled + chrome.alarms → periodic cookie relay
  └─ extension/content.js
       ├─ On app page (http://127.0.0.1:47231):
       │    ├─ syncSubtitleTranslations() → fetch /api/feed → store translations in chrome.storage.local
       │    └─ relayBilibiliCookies() → intent:relayCookies message → background sends cookies to server
       └─ On bilibili video page (https://www.bilibili.com/video/BV...):
            ├─ refreshBilibiliSubtitleMetadata() → fetch subtitle tracks
            ├─ Check chrome.storage.local for pre-translated English entries (with retry loop)
            ├─ Download Chinese subtitle JSON via fetchFromPage() (page context, has cookies)
            ├─ Map translated entries to {from, to, content: translation} format
            └─ startBilibiliSubtitleOverlay() → render positioned <div> over video player

Server (Node.js, src/server.js)
  ├─ POST /api/bilibili-cookies → stores cookie header in bilibiliCookieHeader variable
  ├─ GET /api/feed?refresh=1 → builds feed with bilibili videos:
  │    ├─ applyBilibiliSubtitlePrefilter() → checks each bilibili video for subtitle tracks
  │    │    ├─ english-verified: has English subs with downloadable content → allowed
  │    │    ├─ chinese-needs-translation: has Chinese subs only → allowed, flagged for translation
  │    │    └─ no usable tracks → blocked
  │    ├─ preTranslateChineseSubtitles() → for chinese-needs-translation videos:
  │    │    ├─ Uses fetchJsonViaNode() with cookies to call bilibili player/v2 API
  │    │    ├─ Downloads Chinese subtitle JSON from hdslb.com
  │    │    ├─ Calls translateSubtitleEntries() → Gemini CLI translates Chinese → English
  │    │    └─ setCachedTranslation(bvid, entries) → in-memory Map cache
  │    └─ publicVideo() / publicCachedVideo() → includes subtitleTranslation field from cache
  ├─ GET /api/translated-subtitles?bvid= → returns cached translation
  ├─ GET /api/bilibili/subtitle-tracks?bvid= → proxies bilibili player/v2 API with cookies
  └─ GET /api/bilibili/subtitle-json?url= → proxies subtitle JSON download with cookies
```

## What's Done

- **Server-side pre-translate pipeline**: Works. Cookies arrive, feed builds, Gemini translates Chinese subtitles to English, translations cached in-memory. Verified: BV1jt411L7sg (267 entries), BV1TJ9aBMEfo (428 entries), BV1uGoxB8EFA (160 entries) all translated successfully.
- **Cookie relay**: `sendBilibiliCookies()` in background.js reads `chrome.cookies.getAll` for `.bilibili.com` + `.bilibili.cn`, POSTs cookie header to server. Triggered on `onInstalled`, `onStartup`, and `chrome.alarms` (every 2 min). Content script also triggers via `intent:relayCookies` message (synchronous, no async port issues).
- **Translation sync**: `syncSubtitleTranslations()` on the app page fetches `/api/feed`, extracts `subtitleTranslation` from bilibili items, stores in `chrome.storage.local`. Has logging.
- **Content script overlay**: Reads `chrome.storage.local` for translations, downloads Chinese subtitle JSON from bilibili, renders stacked `<div>` overlay with Chinese (16px) + English (14px) lines.
- **Retry loop**: Content script retries `chrome.storage.local` lookup 6 times (18s total) to handle race where bilibili page loads before sync completes.
- **Bilibili video pages allowed through router**: `classifyBrowserNavigation()` returns `"allow"` for bilibili `/video/` URLs, so users go to the actual bilibili page (not the app redirect).
- **Unit tests**: 31/31 pass (server 19 + video 3 + gemini 9).
- **Dead code removed**: translate bridge iframe, native subtitle activation (shadow DOM), HTTPS server, unused helper functions.

## What's NOT Done (Blocking Issues)

### 1. No bilibili videos with translations in the feed

The feed refresh (`/api/feed?refresh=1`) returns 0 bilibili videos because:
- `applyBilibiliSubtitlePrefilter()` calls `bilibiliSubtitleTracksForUrl()` which uses `fetchBilibiliJson()` in `src/video.js`
- This function uses `globalThis.__intentBilibiliCookie()` for cookies
- The cookie relay works BUT the prefilter runs DURING feed build, which may happen before cookies arrive
- Even with cookies, many bilibili videos return 0 subtitle tracks from the API (AI subtitles require auth cookies including `SESSDATA`)

### 2. Chromium profile corrupted

The default snap Chromium profile at `~/snap/chromium/common/chromium/Default/Preferences` was corrupted during testing (we deleted the extension entry from the JSON). Chromium won't start with this profile anymore.

**Fix**: Delete `~/snap/chromium/common/chromium/Default/Preferences` and let Chromium regenerate it. Then load the extension via `--load-extension`.

### 3. E2E test never verified overlay renders

The full flow has never been confirmed end-to-end. The closest we got:
- Content script IS injected (panel appears, 79 elements hidden)
- Server subtitle-tracks endpoint returns tracks when cookies are present
- But the specific test video had 0 tracks (no subtitles on that particular video)
- No screenshot ever captured showing the overlay with stacked subtitles

### 4. Camoufox for automated testing

Camoufox is installed at `~/.cache/camoufox/camoufox-bin` (Firefox-based). It can be used to:
- Login to bilibili (Firefox stores cookies in **plaintext** in `cookies.sqlite`)
- Extract auth cookies without needing `chrome.cookies.getAll`
- Be driven via remote debugging (`--start-debugger-server 9224`, uses Firefox CDP protocol, NOT Chrome CDP)

**Problem**: Launched in "bot mode" — user can't type in the browser. Need to find the right launch flags for interactive mode. The config is at `~/.cache/camoufox/camoufox.cfg` and `~/.cache/camoufox/camoucfg.jvv`.

## Key Files

| File | Lines | Role |
|------|-------|------|
| `extension/content.js` | 720 | Content script: overlay rendering, subtitle sync, cookie relay, distraction hiding |
| `extension/background.js` | 193 | Service worker: cookie relay, navigation routing, bgFetch proxy |
| `extension/manifest.json` | 39 | MV3 manifest: cookies, storage, webNavigation, tabs permissions |
| `src/server.js` | 911 | HTTP server: feed API, pre-translate pipeline, subtitle track proxying |
| `src/gemini.js` | 356 | Gemini CLI integration: classification, search queries, subtitle translation |
| `src/video.js` | 322 | Video metadata: bilibili API calls, subtitle track detection, yt-dlp wrappers |
| `src/store.js` | 247 | Persistence: config, feed cache, translation cache (in-memory Map) |
| `src/index.js` | 24 | Entry point: creates http.Server from createApp() |

## Critical Technical Details

### Bilibili API requires Referer header
Without `Referer: https://www.bilibili.com/`, the player/v2 API returns tracks with empty `subtitle_url`. Both server-side (`fetchJsonViaNode`) and content script (`fetchFromPage`) include this header.

### Bilibili API requires auth cookies for AI subtitles
Without `SESSDATA` cookie, the `subtitle.subtitles` array in the player/v2 response is always empty. Only authenticated requests see AI-generated subtitle tracks (`ai-zh`).

### Cookie relay is background → server, NOT content script → server
`sendBilibiliCookies()` in background.js uses `chrome.cookies.getAll` (which IS accessible in the service worker) and `fetch()` to POST to the server. This works because the service worker can fetch localhost. The content script triggers this via `intent:relayCookies` message (synchronous `sendResponse`, avoids MV3 port-closing issues).

### Translation cache is in-memory only
`getCachedTranslation(bvid)` / `setCachedTranslation(bvid, entries)` use a `Map` in `src/store.js`. Cache is lost on server restart. No disk persistence.

### Extension ID is deterministic
Snap Chromium with `--load-extension /path` generates extension ID from the path hash. Using the same path = same ID = cached old code. Our extension path is `extension/` in the project root (set in the Chromium profile's Preferences).

### Content script overlay structure
```
<div id="intent-video-subtitle-overlay"
     style="position:absolute;bottom:48px;left:50%;transform:translateX(-50%);
            z-index:100;pointer-events:none;text-align:center;max-width:90%;">
  <div style="color:#fff;background:rgba(0,0,0,0.75);...">Chinese line</div>
  <div style="color:#fff;background:rgba(0,0,0,0.75);...">English translation</div>
</div>
```
Container is positioned inside `.bpx-player-container`, updated on `timeupdate` event.

## Steps to Complete

### Step 1: Fix Chromium profile
```bash
rm ~/snap/chromium/common/chromium/Default/Preferences
rm ~/snap/chromium/common/chromium/Default/"Secure Preferences" 2>/dev/null
```

### Step 2: Get bilibili auth cookies
Option A: Start Chromium with the extension, login to bilibili, extension sends cookies automatically.
Option B: Launch Camoufox in interactive mode, login to bilibili, extract cookies from `cookies.sqlite`:
```python
import sqlite3
conn = sqlite3.connect("/path/to/camoufox-profile/cookies.sqlite")
c = conn.cursor()
c.execute("SELECT name, value, host FROM moz_cookies WHERE host LIKE '%bilibili%'")
cookies = c.fetchall()
header = "; ".join(f"{name}={value}" for name, value, host in cookies)
# POST header to http://127.0.0.1:47231/api/bilibili-cookies
```

### Step 3: Verify feed contains bilibili videos with translations
```bash
curl http://127.0.0.1:47231/api/feed?refresh=1
# Check for bilibili items with subtitleTranslation.entries
```

### Step 4: Test overlay on bilibili video
1. Open `http://127.0.0.1:47231` in the browser with extension → triggers sync
2. Open a bilibili video that has translations
3. Wait 30s for content script to: fetch tracks → check storage → download Chinese JSON → activate overlay
4. Take screenshot via CDP: `Page.captureScreenshot`

### Step 5: Clean up debug logging
Remove the debug log in `src/server.js`:
```javascript
// Line ~184, remove the if (!tracks.length) { console.log(...) } block
```

### Step 6: Run unit tests
```bash
node --test test/server.test.js test/video.test.js test/gemini.test.js
# Expected: 31/31 pass
```

### Step 7: Commit
All changes are uncommitted. `git diff --stat HEAD` shows 12 files changed.

## Snap Chromium Extension Loading Notes

- `--load-extension` works ONLY with paths accessible to the snap sandbox
- Paths under `~/` work. Paths under `/tmp/` do NOT work reliably
- The extension in the default profile is loaded from `/home/camel/Coding/intent-video-gate/extension` (set in Preferences)
- To force code refresh: delete `~/snap/chromium/common/chromium/Default/Extensions/<ext-id>/` and restart
- Extension ID `jmgfdkekfnigkndkebggencoggifkolj` is derived from the load path, NOT from a manifest `key` field (that only works for packed .crx extensions)
- Remove `~/snap/chromium/common/chromium/SingletonLock` if Chromium won't start after a crash

## Camoufox Notes

- Installed at `~/.cache/camoufox/camoufox-bin`
- Version: 135.0.1 (Firefox-based)
- Config: `~/.cache/camoufox/camoufox.cfg`
- Supports `--profile <dir>` for persistent profiles
- Supports `--start-debugger-server <port>` for remote debugging (Firefox CDP protocol, NOT Chrome CDP)
- Firefox stores cookies in **plaintext** in `<profile>/cookies.sqlite`, table `moz_cookies`
- Need to find how to launch in interactive (non-bot) mode for user login
