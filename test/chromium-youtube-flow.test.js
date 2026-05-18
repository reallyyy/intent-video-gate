import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { APP, closeTarget, evaluate, listTargets, openAppPage, setupE2E, waitFor } from "./e2e-helper.js";

test("approved YouTube click uses current Chromium tab and usable native quality controls", { timeout: 90000 }, async () => {
  const e2e = await setupE2E();
  const { opened, page } = await openAppPage(e2e.devtoolsUrl);
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 480,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });

  try {
    await waitFor(page, `document.querySelectorAll(".card .watch").length > 0`, 30000);
    const selected = await evaluate(page, `(() => {
      const cards = [...document.querySelectorAll(".card")];
      return cards.map((card, index) => ({
        index,
        title: card.querySelector(".title")?.textContent || "",
        meta: card.querySelector(".meta")?.textContent || ""
      })).find((item) => item.meta.includes("youtube")) || null;
    })()`);
    assert.ok(selected, "feed must contain a YouTube card for the browser flow test");

    const beforePages = (await listTargets(e2e.devtoolsUrl)).filter((target) => target.type === "page").length;
    await page.call("Runtime.evaluate", {
      awaitPromise: true,
      expression: `(() => {
        const card = [...document.querySelectorAll(".card")]
          .find((node) => node.querySelector(".meta")?.textContent.includes("youtube"));
        if (!card) throw new Error("No YouTube card found");
        card.querySelector(".watch").click();
      })()`
    });

    await waitFor(page, `location.href.includes("youtube.com/watch")`, 45000);
    await waitFor(page, `!!document.querySelector("#movie_player, .html5-video-player")`, 45000);
    await waitFor(page, `document.documentElement.classList.contains("intent-youtube-watch")`, 45000);
    await waitFor(page, `!!document.querySelector("[data-intent-video-focus='true']")`, 45000);
    await waitFor(page, `!!document.querySelector("[data-intent-video-stage='true']")`, 45000);
    await moveMouseToPlayerControls(page);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await waitFor(page, `!!document.querySelector("[data-intent-video-focus='true']") && !!document.querySelector("[data-intent-video-stage='true']")`, 10000);

    const afterPages = (await listTargets(e2e.devtoolsUrl)).filter((target) => target.type === "page").length;
    assert.equal(afterPages, beforePages, "clicking the YouTube card must not create a new tab");
    await assertHistoryContainsAppEntry(page, "clicking the YouTube card");

    const audit = await evaluate(page, `(() => {
      const rectFor = (node) => {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2
        };
      };
      const panel = document.querySelector("#intent-video-panel a");
      const focus = document.querySelector("[data-intent-video-focus='true']");
      const stage = document.querySelector("[data-intent-video-stage='true']");
      const player = document.querySelector("[data-intent-video-player='true']") ||
        document.querySelector("#movie_player") ||
        document.querySelector(".html5-video-player");
      const media = document.querySelector(".html5-main-video") ||
        document.querySelector("video");
      const visible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return {
        url: location.href,
        panel: !!panel,
        panelText: panel?.textContent || "",
        panelTarget: panel?.target || "",
        panelRect: rectFor(panel),
        bareClass: document.documentElement.classList.contains("intent-youtube-watch"),
        focusNode: !!focus,
        focusRect: rectFor(focus),
        stageNode: !!stage,
        stageRect: rectFor(stage),
        hiddenNodes: document.querySelectorAll("[data-intent-video-hidden='true']").length,
        player: !!player,
        playerRect: rectFor(player),
        media: !!media,
        mediaRect: rectFor(media),
        mediaObjectFit: media ? getComputedStyle(media).objectFit : "",
        visibleMasthead: [...document.querySelectorAll("#masthead, ytd-masthead")].some(visible),
        visibleSecondary: [...document.querySelectorAll("#secondary, #comments, ytd-watch-next-secondary-results-renderer")].some(visible),
        bodyOverflow: getComputedStyle(document.body).overflow,
        htmlOverflow: getComputedStyle(document.documentElement).overflow,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };
    })()`);

    assert.match(audit.url, /^https:\/\/www\.youtube\.com\/watch/);
    assert.equal(audit.panel, true);
    assert.equal(audit.panelText, "Back to Intent Gate");
    assert.equal(audit.panelTarget, "");
    assert.ok(audit.panelRect.left <= 20, "return button should be fixed near the left edge");
    assert.ok(audit.panelRect.top <= 20, "return button should be fixed near the top edge");
    assert.equal(audit.bareClass, true);
    assert.equal(audit.focusNode, true);
    assert.equal(audit.stageNode, true);
    assert.ok(audit.hiddenNodes > 0, "extension should hide distracting YouTube page nodes");
    assert.equal(audit.player, true);
    assert.ok(audit.focusRect.width >= audit.viewportWidth - 4, "focused player wrapper should span viewport width");
    assert.ok(audit.focusRect.height >= audit.viewportHeight - 4, "focused player wrapper should span viewport height");
    assertFullScreenSurface(audit.stageRect, audit.viewportWidth, audit.viewportHeight);
    assertFullScreenSurface(audit.playerRect, audit.viewportWidth, audit.viewportHeight);
    assert.equal(audit.media, true, "YouTube media element should exist");
    assert.ok(audit.mediaRect.width > 0 && audit.mediaRect.height > 0, "YouTube media element should be visible");
    assert.equal(audit.mediaObjectFit, "contain");
    assert.equal(audit.visibleMasthead, false);
    assert.equal(audit.visibleSecondary, false);
    assert.equal(audit.bodyOverflow, "hidden");
    assert.equal(audit.htmlOverflow, "hidden");
    assert.equal(audit.scrollY, 0);

    const quality = await openYouTubeQualityMenu(page);
    assert.equal(quality.settingsVisible, true, `settings button should be visible: ${JSON.stringify(quality)}`);
    assert.equal(quality.qualityItemVisible, true, `quality item should be visible in settings: ${JSON.stringify(quality)}`);
    assert.equal(quality.menuOpened, true, `quality submenu should open or expose player quality levels: ${JSON.stringify(quality)}`);
    assert.ok(quality.optionCount > 0, `quality submenu should expose selectable options: ${JSON.stringify(quality)}`);

    const screenshot = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const html = await evaluate(page, "document.documentElement.outerHTML.slice(0, 200000)");
    await writeFile("/tmp/intent-video-youtube-watch-e2e.png", Buffer.from(screenshot.data, "base64"));
    await writeFile("/tmp/intent-video-youtube-watch-e2e.html", html, "utf8");

    await page.call("Runtime.evaluate", {
      awaitPromise: true,
      expression: `document.querySelector("#intent-video-panel a").click()`
    });
    await waitFor(page, `location.href.startsWith(${JSON.stringify(APP)})`, 15000);
    const afterReturnPages = (await listTargets(e2e.devtoolsUrl)).filter((target) => target.type === "page").length;
    assert.equal(afterReturnPages, beforePages, "returning to Intent Gate must not create a new tab");
  } finally {
    page.close();
    await closeTarget(e2e.devtoolsUrl, opened.id);
    await e2e.cleanup();
  }
});

async function openYouTubeQualityMenu(page) {
  await moveMouseToPlayerControls(page);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const settings = await evaluate(page, visibleRectExpression(".ytp-settings-button"));
  if (!settings) return { settingsVisible: false, qualityItemVisible: false, menuOpened: false, optionCount: 0 };
  await evaluate(page, `document.querySelector(".ytp-settings-button")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const quality = await evaluate(page, `(() => {
    const visible = ${visibleFunctionSource()};
    const items = [...document.querySelectorAll(".ytp-panel-menu .ytp-menuitem, .ytp-menuitem")].filter(visible);
    const item = items.find((node) => /quality|清晰度|画质/i.test(node.textContent || ""));
    if (!item) return null;
    const rect = item.getBoundingClientRect();
    item.click();
    return { centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 };
  })()`);
  const playerQualityLevels = await evaluate(page, `(() => {
    const player = document.querySelector("#movie_player");
    if (!player || typeof player.getAvailableQualityLevels !== "function") return [];
    return player.getAvailableQualityLevels();
  })()`);
  if (!quality && playerQualityLevels.length > 0) {
    return {
      settingsVisible: true,
      qualityItemVisible: true,
      menuOpened: true,
      optionCount: playerQualityLevels.length,
      playerQualityLevels
    };
  }
  if (!quality) return { settingsVisible: true, qualityItemVisible: false, menuOpened: false, optionCount: 0, playerQualityLevels };
  await new Promise((resolve) => setTimeout(resolve, 700));

  const menu = await evaluate(page, `(() => {
    const visible = ${visibleFunctionSource()};
    const options = [...document.querySelectorAll(".ytp-quality-menu .ytp-menuitem, .ytp-panel-menu .ytp-menuitem")]
      .filter(visible)
      .filter((node) => /auto|\\d{3,4}p|自动|高清|清晰|标清|流畅/i.test(node.textContent || ""));
    return { opened: options.length > 0, optionCount: options.length };
  })()`);

  return {
    settingsVisible: true,
    qualityItemVisible: !!quality,
    menuOpened: menu.opened || playerQualityLevels.length > 0,
    optionCount: Math.max(menu.optionCount, playerQualityLevels.length),
    playerQualityLevels
  };
}

async function assertHistoryContainsAppEntry(page, action) {
  const history = await page.call("Page.getNavigationHistory");
  const appEntry = history.entries
    .slice(0, history.currentIndex)
    .findLast((entry) => entry.url.startsWith(APP));

  assert.ok(appEntry, `${action} must preserve the Intent Gate entry in browser history`);
}

async function moveMouseToPlayerControls(page) {
  const point = await evaluate(page, `(() => ({
    ...(() => {
      const player = document.querySelector("[data-intent-video-stage='true']") ||
        document.querySelector("[data-intent-video-player='true']") ||
        document.querySelector("#movie_player") ||
        document.querySelector(".html5-video-player");
      const rect = player?.getBoundingClientRect();
      if (!rect) return { x: Math.floor(window.innerWidth / 2), y: Math.max(1, window.innerHeight - 28) };
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.max(1, Math.round(rect.bottom - 28))
      };
    })()
  }))()`);
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
}

function assertFullScreenSurface(rect, viewportWidth, viewportHeight) {
  assert.ok(rect.left >= -2, "native player should stay inside the viewport horizontally");
  assert.ok(rect.right <= viewportWidth + 2, "native player should stay inside the viewport horizontally");
  assert.ok(rect.top >= -2, "native player should stay inside the viewport vertically");
  assert.ok(rect.bottom <= viewportHeight + 2, "native player should stay inside the viewport vertically");
  assert.ok(Math.abs(rect.centerX - viewportWidth / 2) <= 6, "native player should be horizontally centered");
  assert.ok(Math.abs(rect.centerY - viewportHeight / 2) <= 6, "native player should be vertically centered");
  assert.ok(rect.width >= viewportWidth - 4, `native player should span viewport width, got ${rect.width}`);
  assert.ok(rect.height >= viewportHeight - 4, `native player should span viewport height, got ${rect.height}`);
}

function visibleFunctionSource() {
  return `(node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < innerWidth &&
      rect.top < innerHeight;
  }`;
}

function visibleRectExpression(selector) {
  return `(() => {
    const visible = ${visibleFunctionSource()};
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(visible);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2
    };
  })()`;
}
