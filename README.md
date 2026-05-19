# Intent Video Gate

Barebones mixed video app for YouTube and Bilibili. The app shows one filter field and a feed of Gemini-approved videos only. Blocked content is not rendered.

## Requirements

- Node 20+
- `gemini` CLI authenticated
- `yt-dlp` for recommendation metadata extraction
- Chromium or Brave with the extension loaded and signed into YouTube/Bilibili

Run:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:47231
```

Check dependencies:

```bash
npm run doctor
```

By default, config and state live in `~/.config/intent-video` and `~/.local/share/intent-video`. If those directories are unavailable, the app falls back to `.intent-video/` inside the current project. You can force paths with `INTENT_VIDEO_CONFIG_DIR` and `INTENT_VIDEO_DATA_DIR`.

## Browser Extension

Load `extension/` as an unpacked extension. It blocks normal platform browsing, allows short-lived approved watch URLs, strips native watch pages, and forwards Bilibili recommendation cards to the local app.

Sign into YouTube Premium and Bilibili in Brave once. The app does not store account credentials.

## Barebones Watch Mode

Clicking a YouTube or Bilibili card creates a short-lived grant for that exact video URL and navigates the current tab to the real signed-in watch page. The extension strips the page down to a bare full-window player surface while preserving the video aspect ratio, native quality selector, subtitles, full-length view tracking, and account history.

For Bilibili, recommendations are eligible only when Bilibili exposes an English-capable or bilingual subtitle/CC track. Chinese-only AI subtitles are filtered out because stacked subtitles need visible source and English lines to be useful, without any paid translation API.

The watch flow must not create new tabs or windows.

The local app remains the unified place for the mixed approved feed.

## Gemini Integration

The app calls Gemini headlessly:

```bash
gemini -p "<prompt>" -m gemini-3.1-flash-lite-preview -y --skip-trust --output-format json
```

It parses the outer Gemini JSON and then parses strict decision JSON from the `response` field. Invalid or missing AI output blocks the candidate.

## Commands

```bash
npm test
npm start
npm run doctor
```
