# Repository Instructions

- Do not skip Chromium E2E tests because the app server or DevTools endpoint is missing.
- When running browser tests, discover `CHROMIUM_DEBUG_URL` first, then local DevTools ports such as `9222` and `9223`.
- If no DevTools endpoint is available, start Chromium or Brave with the repo extension loaded and run the tests against that browser.
- If the local app is not available at `127.0.0.1:47231`, start it before running E2E tests.
- Watch-mode changes must be tested against live YouTube and Bilibili E2E flows whenever platform access is available.
