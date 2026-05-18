import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { APP, closeTarget, evaluate, listTargets, openAppPage, setupE2E, waitFor } from "./e2e-helper.js";

test("approved Bilibili click uses current Chromium tab and bare native watch page", { timeout: 90000 }, async () => {
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
      })).find((item) => item.meta.includes("bilibili")) || null;
    })()`);
    assert.ok(selected, "feed must contain a Bilibili card for the browser flow test");

    const beforePages = (await listTargets(e2e.devtoolsUrl)).filter((target) => target.type === "page").length;
    await page.call("Runtime.evaluate", {
      awaitPromise: true,
      expression: `(() => {
        const card = [...document.querySelectorAll(".card")]
          .find((node) => node.querySelector(".meta")?.textContent.includes("bilibili"));
        if (!card) throw new Error("No Bilibili card found");
        card.querySelector(".watch").click();
      })()`
    });

    await waitFor(page, `location.href.includes("bilibili.com/video/")`, 45000);
    await waitFor(page, `!!(document.querySelector(".bpx-player-container") || document.querySelector("#bilibili-player"))`, 45000);
    await waitFor(page, `document.documentElement.classList.contains("intent-bilibili-watch")`, 45000);
    await waitFor(page, `!!document.querySelector("[data-intent-video-stage='true']")`, 45000);
    await moveMouseToPlayerControls(page);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await waitFor(page, `!!document.querySelector("[data-intent-video-focus='true']") && !!document.querySelector("[data-intent-video-stage='true']")`, 10000);

    const afterPages = (await listTargets(e2e.devtoolsUrl)).filter((target) => target.type === "page").length;
    assert.equal(afterPages, beforePages, "clicking the Bilibili card must not create a new tab");
    await assertHistoryContainsAppEntry(page, "clicking the Bilibili card");

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
        document.querySelector(".bpx-player-container") ||
        document.querySelector("#bilibili-player");
      const media = document.querySelector(".bpx-player-video-wrap video") ||
        document.querySelector("video");
      return {
        url: location.href,
        title: document.title,
        panel: !!panel,
        panelText: panel?.textContent || "",
        panelTarget: panel?.target || "",
        panelRect: rectFor(panel),
        bareClass: document.documentElement.classList.contains("intent-bilibili-watch"),
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
        subtitleControl: !!document.querySelector("[class*=subtitle], [aria-label*=字幕], [title*=字幕]"),
        qualityControl: !!document.querySelector("[class*=quality], [aria-label*=清晰度], [title*=清晰度]"),
        visibleHeader: [...document.querySelectorAll(".bili-header, [class*='bili-header'], [class*='BiliHeader'], .international-header, .mini-header, [class*='left-entry'], [class*='center-search'], [class*='right-entry'], [class*='nav-search'], [class*='upload']")]
          .some((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          }),
        visibleTitleOutsidePlayer: [...document.body.querySelectorAll("*")]
          .some((node) => {
            if (!node.innerText || !node.innerText.includes(${JSON.stringify(selected.title)})) return false;
            if (node.closest(".bpx-player-container, #bilibili-player")) return false;
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          }),
        visibleDiscussionOutsidePlayer: [...document.querySelectorAll(".reply-warp, .reply-wrap, .reply-container, [class*='reply'], [class*='Reply'], .comment, .comment-container, #comment, [class*='comment'], [class*='Comment'], .tag-panel, .video-tag-container, [class*='tag-panel']")]
          .some((node) => {
            if (node.closest(".bpx-player-container, #bilibili-player")) return false;
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          }),
        bodyOverflow: getComputedStyle(document.body).overflow,
        htmlOverflow: getComputedStyle(document.documentElement).overflow,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };
    })()`);

    assert.match(audit.url, /^https:\/\/www\.bilibili\.com\/video\//);
    assert.equal(audit.panel, true);
    assert.equal(audit.panelText, "Back to Intent Gate");
    assert.equal(audit.panelTarget, "");
    assert.ok(audit.panelRect.left <= 20, "return button should be fixed near the left edge");
    assert.ok(audit.panelRect.top <= 20, "return button should be fixed near the top edge");
    assert.ok(audit.panelRect.width > 0 && audit.panelRect.height > 0, "return button should be visible");
    assert.equal(audit.bareClass, true);
    assert.equal(audit.focusNode, true);
    assert.equal(audit.stageNode, true);
    assert.ok(audit.hiddenNodes > 0, "extension should hide distracting Bilibili page nodes");
    assert.equal(audit.player, true);
    assert.ok(audit.focusRect.width >= audit.viewportWidth - 4, "focused player wrapper should span viewport width");
    assert.ok(audit.focusRect.height >= audit.viewportHeight - 4, "focused player wrapper should span viewport height");
    assert.ok(audit.focusRect.left <= 2 && audit.focusRect.top <= 2, "focused player wrapper should start at viewport origin");
    assertFullScreenSurface(audit.stageRect, audit.viewportWidth, audit.viewportHeight);
    assertFullScreenSurface(audit.playerRect, audit.viewportWidth, audit.viewportHeight);
    assert.equal(audit.media, true, "Bilibili media element should exist");
    assert.ok(audit.mediaRect.width > 0 && audit.mediaRect.height > 0, "Bilibili media element should be visible");
    assert.equal(audit.mediaObjectFit, "contain");
    assert.equal(audit.visibleHeader, false);
    assert.equal(audit.visibleTitleOutsidePlayer, false);
    assert.equal(audit.visibleDiscussionOutsidePlayer, false);
    assert.equal(audit.bodyOverflow, "hidden");
    assert.equal(audit.htmlOverflow, "hidden");
    assert.equal(audit.scrollY, 0);

    const nativeControls = await exerciseNativePlayerControls(page);
    assert.equal(nativeControls.quality.visible, true, `quality control should be visible in the native player: ${JSON.stringify(nativeControls.quality)}`);
    assert.equal(nativeControls.quality.menuOpened, true, `quality control should open a selectable menu: ${JSON.stringify(nativeControls.quality)}`);
    assert.ok(nativeControls.quality.optionCount > 0, `quality menu should expose at least one option: ${JSON.stringify(nativeControls.quality)}`);
    assert.equal(nativeControls.playbackRate.visible, true, `playback-rate control should be visible in the native player: ${JSON.stringify(nativeControls.playbackRate)}`);
    assert.equal(nativeControls.subtitle.visible, true, `subtitle control should be visible in the native player: ${JSON.stringify(nativeControls.subtitle)}`);

    const screenshot = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const html = await evaluate(page, "document.documentElement.outerHTML.slice(0, 200000)");
    await writeFile("/tmp/intent-video-bilibili-watch-e2e.png", Buffer.from(screenshot.data, "base64"));
    await writeFile("/tmp/intent-video-bilibili-watch-e2e.html", html, "utf8");

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
        document.querySelector(".bpx-player-container") ||
        document.querySelector("#bilibili-player");
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

async function exerciseNativePlayerControls(page) {
  await moveMouseToPlayerControls(page);
  await waitFor(page, nativeControlsReadyExpression(), 15000);

  const quality = await revealNativeControlMenu(page, {
    label: "quality",
    controlNeedles: ["quality", "清晰度"],
    optionNeedles: ["自动", "清晰", "流畅", "高清", "超清", "蓝光", "原画", "hdr", "4k", "1080", "720", "480", "360"]
  });

  await moveMouseToPlayerControls(page);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const playbackRate = await revealNativeControlMenu(page, {
    label: "playbackRate",
    controlNeedles: ["playbackrate", "倍速"],
    optionNeedles: ["倍速", "0.5", "0.75", "1.0", "1.25", "1.5", "2.0"]
  });

  await moveMouseToPlayerControls(page);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const subtitle = await revealNativeControlMenu(page, {
    label: "subtitle",
    controlNeedles: ["subtitle", "字幕"],
    optionNeedles: ["字幕", "关闭", "开启", "中文", "english", "自动"]
  });

  return { quality, playbackRate, subtitle };
}

function nativeControlsReadyExpression() {
  return `(() => {
    const visible = (node) => {
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
    };
    return [
      ".bpx-player-ctrl-quality",
      ".bpx-player-ctrl-playbackrate",
      ".bpx-player-ctrl-subtitle"
    ].every((selector) => [...document.querySelectorAll(selector)].some(visible));
  })()`;
}

async function revealNativeControlMenu(page, { label, controlNeedles, optionNeedles }) {
  const control = await evaluate(page, controlFinderExpression(controlNeedles));
  if (!control) return await revealFromSettingsMenu(page, { label, controlNeedles, optionNeedles });

  await page.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.round(control.centerX),
    y: Math.round(control.centerY)
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: Math.round(control.centerX),
    y: Math.round(control.centerY),
    button: "left",
    clickCount: 1
  });
  await page.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: Math.round(control.centerX),
    y: Math.round(control.centerY),
    button: "left",
    clickCount: 1
  });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const menu = await evaluate(page, menuFinderExpression([...optionNeedles, ...controlNeedles], control));
  return {
    label,
    visible: true,
    menuOpened: menu.opened,
    optionCount: menu.optionCount
  };
}

async function revealFromSettingsMenu(page, { label, controlNeedles, optionNeedles }) {
  const settings = await evaluate(page, controlFinderExpression(["setting", "设置"]));
  if (!settings) return { label, visible: false, menuOpened: false, optionCount: 0 };

  await page.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.round(settings.centerX),
    y: Math.round(settings.centerY)
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: Math.round(settings.centerX),
    y: Math.round(settings.centerY),
    button: "left",
    clickCount: 1
  });
  await page.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: Math.round(settings.centerX),
    y: Math.round(settings.centerY),
    button: "left",
    clickCount: 1
  });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const menu = await evaluate(page, menuFinderExpression([...optionNeedles, ...controlNeedles], settings));
  return {
    label,
    visible: menu.opened,
    menuOpened: menu.opened,
    optionCount: menu.optionCount
  };
}

function controlFinderExpression(needles) {
  return `(() => {
    const needles = ${JSON.stringify(needles.map((needle) => needle.toLowerCase()))};
    const visible = (node) => {
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
    };
    const textFor = (node) => [
      node.textContent || "",
      node.getAttribute("aria-label") || "",
      node.getAttribute("title") || "",
      typeof node.className === "string" ? node.className : ""
    ].join(" ").toLowerCase();
    const candidates = [...document.querySelectorAll("button, [role='button'], [class*='quality'], [class*='playbackrate'], [class*='subtitle'], [class*='setting'], [aria-label], [title]")];
    const match = candidates
      .filter(visible)
      .find((node) => needles.some((needle) => textFor(node).includes(needle)));
    if (!match) return null;
    const rect = match.getBoundingClientRect();
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

function menuFinderExpression(needles, control) {
  return `(() => {
    const needles = ${JSON.stringify(needles.map((needle) => needle.toLowerCase()))};
    const control = ${JSON.stringify(control)};
    const visible = (node) => {
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
    };
    const textFor = (node) => [
      node.textContent || "",
      node.getAttribute("aria-label") || "",
      node.getAttribute("title") || "",
      typeof node.className === "string" ? node.className : ""
    ].join(" ").toLowerCase();
    const isOutsideControl = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.right < control.left ||
        rect.left > control.left + control.width ||
        rect.bottom < control.top ||
        rect.top > control.top + control.height;
    };
    const options = [...document.querySelectorAll("li, button, [role='menuitem'], [role='option'], [class*='quality'], [class*='playbackrate'], [class*='subtitle'], [class*='setting'], [class*='option'], [class*='menu'], [class*='panel']")]
      .filter((node) => visible(node) && isOutsideControl(node) && needles.some((needle) => textFor(node).includes(needle)));
    return {
      opened: options.length > 0,
      optionCount: options.length
    };
  })()`;
}
