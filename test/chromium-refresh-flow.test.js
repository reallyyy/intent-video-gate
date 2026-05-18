import test from "node:test";
import assert from "node:assert/strict";
import { closeTarget, evaluate, openAppPage, setupRefreshE2E, waitFor } from "./e2e-helper.js";

test("refresh rebuilds the Chromium feed with YouTube and Bilibili videos", { timeout: 90000 }, async () => {
  const e2e = await setupRefreshE2E();
  const { opened, page } = await openAppPage(e2e.devtoolsUrl, e2e.appUrl);

  try {
    await waitFor(page, `document.querySelectorAll(".card").length === 1`, 30000);
    const cached = await cards(page);
    assert.deepEqual(cached.map((item) => item.title), ["Stale cached video"]);

    await evaluate(page, `document.querySelector("#refresh").click()`);
    await waitFor(page, `(() => {
      const metas = [...document.querySelectorAll(".card .meta")].map((node) => node.textContent || "");
      return metas.filter((meta) => meta.includes("youtube")).length >= 2 &&
        metas.some((meta) => meta.includes("bilibili")) &&
        document.querySelector("#refresh")?.getAttribute("aria-busy") === "false";
    })()`, 30000);

    const refreshed = await cards(page);
    const platforms = refreshed.map((item) => item.platform);
    assert.equal(refreshed.length, 3);
    assert.equal(platforms.filter((platform) => platform === "youtube").length, 2);
    assert.equal(platforms.filter((platform) => platform === "bilibili").length, 1);
    assert.deepEqual(refreshed.map((item) => item.title), [
      "Bilibili refreshed E2E video",
      "YouTube refreshed E2E video one",
      "YouTube refreshed E2E video two"
    ]);
    assert.equal(await evaluate(page, `document.querySelector("#status")?.textContent`), "3 videos");
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
