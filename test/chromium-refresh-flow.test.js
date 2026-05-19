import test from "node:test";
import assert from "node:assert/strict";
import { closeTarget, evaluate, openAppPage, setupRefreshE2E, waitFor } from "./e2e-helper.js";

test("refresh rebuilds the Chromium feed with YouTube and Bilibili videos", { timeout: 90000 }, async () => {
  const e2e = await setupRefreshE2E();
  const { opened, page } = await openAppPage(e2e.devtoolsUrl, e2e.appUrl);

  try {
    await waitFor(page, `document.querySelectorAll(".card").length === 2`, 30000);
    const cached = await cards(page);
    assert.deepEqual(cached.map((item) => item.title), ["Stale cached video", "Stale Bilibili cached suggestion"]);

    await evaluate(page, `document.querySelector("#refresh").click()`);
    await waitFor(page, `(() => {
      const metas = [...document.querySelectorAll(".card .meta")].map((node) => node.textContent || "");
      return metas.filter((meta) => meta.includes("youtube")).length >= 2 &&
        metas.some((meta) => meta.includes("bilibili")) &&
        document.querySelector("#refresh")?.getAttribute("aria-busy") === "false";
    })()`, 30000);

    const refreshed = await cards(page);
    const platforms = refreshed.map((item) => item.platform);
    assert.equal(refreshed.length, 4);
    assert.equal(platforms.filter((platform) => platform === "youtube").length, 2);
    assert.equal(platforms.filter((platform) => platform === "bilibili").length, 2);
    assert.deepEqual(refreshed.map((item) => item.title), [
      "YouTube refreshed E2E video one",
      "YouTube refreshed E2E video two",
      "Bilibili refreshed E2E video",
      "Stale Bilibili cached suggestion"
    ]);
    assert.match(await evaluate(page, `document.querySelector("#status")?.textContent`), /^4 videos/);
  } finally {
    page.close();
    await closeTarget(e2e.devtoolsUrl, opened.id);
    await e2e.cleanup();
  }
});

test("blocked words auto-save, refresh, and persist in Chromium", { timeout: 90000 }, async () => {
  const e2e = await setupRefreshE2E();
  const { opened, page } = await openAppPage(e2e.devtoolsUrl, e2e.appUrl);

  try {
    await waitFor(page, `document.querySelectorAll(".card").length === 2`, 30000);

    await evaluate(page, `(() => {
      const input = document.querySelector("#keywordInput");
      input.value = "YouTube";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#addKeyword").click();
    })()`);
    await waitFor(page, `(() => {
      const titles = [...document.querySelectorAll(".card .title")].map((node) => node.textContent || "");
      const chips = [...document.querySelectorAll(".keyword-chip")].map((node) => node.textContent || "");
      return document.querySelector("#refresh")?.getAttribute("aria-busy") === "false" &&
        titles.length === 2 &&
        titles[0] === "Bilibili refreshed E2E video" &&
        titles[1] === "Stale Bilibili cached suggestion" &&
        chips.some((text) => text.includes("YouTube"));
    })()`, 30000);

    await evaluate(page, `location.reload()`);
    await waitFor(page, `(() => [...document.querySelectorAll(".keyword-chip")].some((node) => (node.textContent || "").includes("YouTube")))()`, 30000);
  } finally {
    page.close();
    await closeTarget(e2e.devtoolsUrl, opened.id);
    await e2e.cleanup();
  }
});

async function cards(page) {
  return evaluate(page, `(() => [...document.querySelectorAll(".card")].map((card) => {
    const meta = card.querySelector(".meta")?.textContent || "";
    return {
      title: card.querySelector(".title")?.textContent || "",
      meta,
      platform: meta.split(" · ")[0] || "",
      hasWatch: !!card.querySelector(".watch"),
      hasTune: !!card.querySelector(".tune")
    };
  }))()`);
}
