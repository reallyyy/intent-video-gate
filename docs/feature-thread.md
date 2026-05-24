# Feature Thread Draft

1. I built Intent Video Gate as a local-first way to stop passive video feeds from taking over.

You write an intent like "show serious engineering, history, and economics explainers; avoid clickbait and low-effort reactions." The app builds a feed from YouTube and Bilibili, then asks Gemini to classify each candidate.

2. The key idea is not "block a site."

It is "only let me watch videos that match what I actually meant to watch."

The browser extension blocks direct YouTube and Bilibili browsing. You can only open a video through the approved local feed.

3. When you click Watch, the extension opens the real signed-in watch page in the same tab.

That means native player controls still work: quality, playback speed, subtitles, account history, and platform view tracking. The page is stripped down to the fullscreen player.

4. Bilibili support was the hardest part.

Bilibili often has useful Chinese content, but not always English subtitles. The app can use English or bilingual subtitle tracks when they exist. For Chinese-only tracks, it translates the subtitle file server-side and renders a stacked Chinese + English overlay.

5. The overlay now handles Chinese AI subtitles better.

Bilibili Chinese AI subtitles can be tiny fragments while the English sentence is longer. The overlay anchors on the active English cue and merges the matching Chinese chunks, so the source line is easier to track.

6. I also added a stricter subtitle quality gate.

The app now rejects stale or partial cached translations. It fingerprints the current Chinese subtitle source and checks coverage before using a cached English translation.

If the cache does not match the current video, it gets invalidated.

7. Important rule: Chinese-only Bilibili translation is capped at 10 minutes.

If the Chinese subtitle timeline is longer than 600 seconds, the video is filtered out unless it already has English/bilingual subtitles.

This keeps refreshes fast and avoids long flaky translation jobs.

8. Music is handled separately.

Gemini can mark true music videos or live performances as `music-no-subtitles`. Those can pass without subtitles because understanding spoken language is not the point.

Music analysis, interviews, lectures, podcasts, and commentary still need subtitles.

9. Everything is local.

The server runs at `127.0.0.1:47231`. Config and cache are local files. The extension talks to the local server. The project has no npm dependencies.

10. To try it:

```bash
git clone https://github.com/reallyyy/intent-video-gate.git
cd intent-video-gate
npm start
```

Then load `extension/` as an unpacked Chromium or Brave extension and sign into YouTube and Bilibili in that browser profile.

11. Developer notes:

Run `npm test` for unit and Chromium E2E coverage. The tests discover an existing DevTools endpoint or launch Chromium/Brave with the extension loaded. The Bilibili tests exercise the real watch-page subtitle overlay.

12. The repo is here:

https://github.com/reallyyy/intent-video-gate

The current focus is making feeds intentional, keeping native watch pages usable, and making Bilibili's Chinese subtitle ecosystem workable for English readers without turning the app into a cloud service.
