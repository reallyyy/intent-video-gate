import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { APP, closeTarget, evaluate, listTargets, openAppPage, setupE2E, waitFor } from "./e2e-helper.js";

async function injectBilibiliCookies(page) {
  const cookiePath = process.env.INTENT_VIDEO_BILIBILI_COOKIES || "/tmp/ivg-bilibili-cookies.json";
  let cookies;
  try {
    cookies = JSON.parse(await readFile(cookiePath, "utf8"));
  } catch {
    return;
  }
  for (const cookie of cookies) {
    await page.call("Network.setCookie", {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      secure: cookie.secure ?? true,
      httpOnly: cookie.httpOnly ?? false,
      sameSite: cookie.sameSite || "Lax"
    });
  }
}

test("approved Bilibili click uses current Chromium tab and bare native watch page", { timeout: 90000 }, async () => {
  const e2e = await setupE2E();
  const { opened, page } = await openAppPage(e2e.devtoolsUrl);
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 480,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  await injectBilibiliCookies(page);

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

    await ensureBilibiliPlayback(page);
    try {
      await waitFor(page, stackedSubtitleReadyExpression(), 45000);
    } catch (error) {
      const availability = await evaluate(page, nativeBilibiliSubtitleAvailabilityExpression());
      if (availability.loginRequired && !availability.hasEnglishOption) {
        assert.fail([
          "Bilibili native stacked English subtitles are login-gated in this browser profile.",
          "Run this E2E with a logged-in Bilibili Chromium/Brave profile, for example:",
          "  INTENT_VIDEO_E2E_PROFILE=/path/to/logged-in/user-data-dir npm test -- test/chromium-bilibili-flow.test.js",
          "or start a logged-in browser with remote debugging and set CHROMIUM_DEBUG_URL.",
          `Availability: ${JSON.stringify(availability)}`,
          `Original wait error: ${error.message}`
        ].join("\n"));
      }
      throw error;
    }
    const stackedSubtitles = await evaluate(page, stackedSubtitleAuditExpression());
    assert.equal(stackedSubtitles.status, "ready", `extension should mark native stacked subtitles ready: ${JSON.stringify(stackedSubtitles)}`);
    assert.ok(stackedSubtitles.sourceText, `source subtitle text should be visible: ${JSON.stringify(stackedSubtitles)}`);
    assert.ok(stackedSubtitles.englishText, `English subtitle text should be visible: ${JSON.stringify(stackedSubtitles)}`);
    assert.notEqual(stackedSubtitles.sourceText, stackedSubtitles.englishText);
    assert.equal(stackedSubtitles.sourceHasCjk, true, `source subtitle should contain CJK text: ${JSON.stringify(stackedSubtitles)}`);
    assert.equal(stackedSubtitles.englishHasLatin, true, `English subtitle should contain Latin words: ${JSON.stringify(stackedSubtitles)}`);
    assert.ok(stackedSubtitles.englishTop > stackedSubtitles.sourceTop, `English subtitle should be stacked below source subtitle: ${JSON.stringify(stackedSubtitles)}`);

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
    await writeFile("/tmp/intent-video-bilibili-stacked-subtitles-e2e.png", Buffer.from(screenshot.data, "base64"));
    await writeFile("/tmp/intent-video-bilibili-stacked-subtitles-e2e.html", html, "utf8");

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
    optionNeedles: ["字幕", "关闭", "开启", "中文", "english", "自动", "双语字幕"]
  });

  return { quality, playbackRate, subtitle };
}

async function ensureBilibiliPlayback(page) {
  await evaluate(page, `(() => {
    const video = document.querySelector("video");
    if (!video) return false;
    if (Number.isFinite(video.duration) && video.duration > 20 && video.currentTime < 8) {
      video.currentTime = 12;
    }
    video.muted = true;
    const play = video.play?.();
    if (play && typeof play.catch === "function") play.catch(() => {});
    return true;
  })()`);
  await moveMouseToPlayerControls(page);
}

function stackedSubtitleReadyExpression() {
  return `(() => {
    const audit = (${stackedSubtitleAuditExpression()});
    return audit.status === "ready" &&
      audit.sourceText &&
      audit.englishText &&
      audit.sourceHasCjk &&
      audit.englishHasLatin &&
      audit.englishTop > audit.sourceTop;
  })()`;
}

function stackedSubtitleAuditExpression() {
  return `(() => {
    const normalize = (text) => String(text || "").replace(/\\r/g, "").split("\\n").map((line) => line.replace(/\\s+/g, " ").trim()).filter(Boolean).join("\\n").trim();
    const hasCjk = (text) => /[\\u3400-\\u9fff]/.test(String(text || ""));
    const hasLatin = (text) => /\\b[A-Za-z][A-Za-z'-]{2,}\\b/.test(String(text || ""));
    const visible = (node) => {
      if (!node) return false;
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
    const lineFor = (selector) => {
      const node = [...document.querySelectorAll(selector)].find(visible);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { text: normalize(node.textContent), top: rect.top, left: rect.left, width: rect.width, height: rect.height, selector };
    };
    let source = lineFor(".bili-subtitle-x-subtitle-panel-major-group, [class*='subtitle-panel-major']");
    let english = lineFor(".bili-subtitle-x-subtitle-panel-minor-group, [class*='subtitle-panel-minor']");
    if (!(source?.text && english?.text)) {
      const roots = [...document.querySelectorAll(".bpx-player-subtitle-wrap, .bili-subtitle-x-subtitle-panel, .bilibili-player-video-subtitle, [data-intent-video-player='true']")]
        .filter(visible);
      for (const root of roots) {
        const rootRect = root.getBoundingClientRect();
        const lines = normalize(root.innerText || root.textContent || "")
          .split("\\n")
          .map((line) => line.trim())
          .filter((line) => line.length >= 2 && !/^(字幕|关闭|开启|自动|设置|双语字幕)$/.test(line));
        for (let i = 0; i < lines.length - 1; i += 1) {
          if (hasCjk(lines[i]) && hasLatin(lines[i + 1])) {
            source = { text: lines[i], top: rootRect.top, left: rootRect.left, width: rootRect.width, height: rootRect.height / 2, selector: "rendered-subtitle-root" };
            english = { text: lines[i + 1], top: rootRect.top + Math.max(1, rootRect.height / 2), left: rootRect.left, width: rootRect.width, height: rootRect.height / 2, selector: "rendered-subtitle-root" };
            break;
          }
          if (hasLatin(lines[i]) && hasCjk(lines[i + 1])) {
            source = { text: lines[i + 1], top: rootRect.top + Math.max(1, rootRect.height / 2), left: rootRect.left, width: rootRect.width, height: rootRect.height / 2, selector: "rendered-subtitle-root" };
            english = { text: lines[i], top: rootRect.top, left: rootRect.left, width: rootRect.width, height: rootRect.height / 2, selector: "rendered-subtitle-root" };
            break;
          }
          for (let j = i + 2; j < Math.min(lines.length, i + 5); j += 1) {
            if (hasCjk(lines[i]) && hasLatin(lines[j])) {
              source = { text: lines[i], top: rootRect.top + i, left: rootRect.left, width: rootRect.width, height: 1, selector: "rendered-subtitle-nearby-lines" };
              english = { text: lines[j], top: rootRect.top + j, left: rootRect.left, width: rootRect.width, height: 1, selector: "rendered-subtitle-nearby-lines" };
              break;
            }
          }
          if (source?.text && english?.text) break;
        }
        if (source?.text && english?.text) break;
      }
    }
    if (!(source?.text && english?.text)) {
      const leaves = [...document.querySelectorAll(".bpx-player-subtitle-wrap *, .bili-subtitle-x-subtitle-panel *, .bilibili-player-video-subtitle *, [data-intent-video-player='true'] *")]
        .filter((node) => node.childElementCount === 0 && visible(node))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { text: normalize(node.textContent), top: rect.top, left: rect.left, width: rect.width, height: rect.height, selector: typeof node.className === "string" ? node.className : node.tagName };
        })
        .filter((line) => line.text && !/^(字幕|关闭|开启|自动|设置|双语字幕)$/.test(line.text));
      source = leaves.find((line) => hasCjk(line.text)) || source;
      english = leaves.find((line) => hasLatin(line.text) && line.text !== source?.text && line.top > Number(source?.top || -1)) || english;
    }
    return {
      status: document.documentElement.dataset.intentBilibiliSubtitles || "",
      source: document.documentElement.dataset.intentBilibiliSubtitleSource || "",
      sourceText: source?.text || "",
      englishText: english?.text || "",
      sourceTop: Number(source?.top || 0),
      englishTop: Number(english?.top || 0),
      sourceHasCjk: hasCjk(source?.text || ""),
      englishHasLatin: hasLatin(english?.text || ""),
      sourceSelector: source?.selector || "",
      englishSelector: english?.selector || ""
    };
  })()`;
}

function nativeBilibiliSubtitleAvailabilityExpression() {
  return `(() => {
    const text = document.body?.innerText || "";
    const nodes = [...document.querySelectorAll("[class*=subtitle], [aria-label*=字幕], [title*=字幕]")];
    const combined = nodes.map((node) => [
      node.textContent || "",
      node.getAttribute("aria-label") || "",
      node.getAttribute("title") || "",
      typeof node.className === "string" ? node.className : ""
    ].join(" ")).join("\\n");
    return {
      loginRequired: /登录可享|请先登录|登录/.test(text),
      hasEnglishOption: /English|英文|英语/i.test(text) || /English|英文|英语/i.test(combined),
      hasBilingualOption: /双语字幕|bilingual/i.test(text) || /双语字幕|bilingual/i.test(combined),
      status: document.documentElement.dataset.intentBilibiliSubtitles || "",
      bodyText: text.slice(0, 500)
    };
  })()`;
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
    optionCount: menu.optionCount,
    hasEnglishOption: menu.hasEnglishOption,
    hasBilingualOption: menu.hasBilingualOption
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
    optionCount: menu.optionCount,
    hasEnglishOption: menu.hasEnglishOption,
    hasBilingualOption: menu.hasBilingualOption
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
      optionCount: options.length,
      hasEnglishOption: options.some((node) => /english|英文|英语/i.test(textFor(node))),
      hasBilingualOption: options.some((node) => /双语字幕|bilingual/i.test(textFor(node)))
    };
  })()`;
}
