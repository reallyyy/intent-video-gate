import test from "node:test";
import assert from "node:assert/strict";
import { APP, closeTarget, evaluate, listTargets, openAppPage, setupE2E, waitFor } from "./e2e-helper.js";

test("signed-in platforms hide login buttons and direct platform browsing stays blocked", { timeout: 60000 }, async () => {
  const e2e = await setupE2E();
  const { opened, page } = await openAppPage(e2e.devtoolsUrl);

  try {
    await waitFor(page, `!!document.querySelector("#loginYoutube") && !!document.querySelector("#loginBilibili")`, 15000);
    await setAuth("youtube", "signedOut");
    await setAuth("bilibili", "signedOut");
    await refreshAppAuth(page);
    await waitFor(page, `!document.querySelector("#loginYoutube").hidden && !document.querySelector("#loginBilibili").hidden`, 15000);

    await setAuth("youtube", "signedIn");
    await refreshAppAuth(page);
    await waitFor(page, `document.querySelector("#loginYoutube").hidden && !document.querySelector("#loginBilibili").hidden`, 15000);

    await setAuth("bilibili", "signedIn");
    await refreshAppAuth(page);
    await waitFor(page, `document.querySelector("#loginYoutube").hidden && document.querySelector("#loginBilibili").hidden && document.querySelector(".login-actions").hidden`, 15000);

    for (const url of [
      "https://www.youtube.com/gaming",
      "https://gaming.youtube.com/",
      "https://www.bilibili.com/v/game",
      "https://game.bilibili.com/"
    ]) {
      await assertBlockedNavigation(page, e2e.devtoolsUrl, url);
    }
  } finally {
    page.close();
    await closeTarget(e2e.devtoolsUrl, opened.id);
    await e2e.cleanup();
  }
});

async function setAuth(platform, status) {
  const response = await fetch(`${APP}api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform, status })
  });
  assert.equal(response.ok, true, `setting ${platform} auth state should succeed`);
}

async function refreshAppAuth(page) {
  await page.call("Runtime.evaluate", {
    awaitPromise: true,
    expression: `window.dispatchEvent(new Event("focus"))`
  });
}

async function assertBlockedNavigation(page, devtoolsUrl, url) {
  const beforePages = (await listTargets(devtoolsUrl)).filter((target) => target.type === "page").length;
  await page.call("Page.navigate", { url });
  await waitFor(page, `location.href.startsWith(${JSON.stringify(APP)}) && new URL(location.href).searchParams.has("blocked")`, 15000);
  const afterPages = (await listTargets(devtoolsUrl)).filter((target) => target.type === "page").length;
  assert.ok(afterPages <= beforePages, `${url} must be blocked in the current tab without opening a new tab`);
  const blocked = await evaluate(page, `new URL(location.href).searchParams.get("blocked")`);
  assert.equal(blocked, url);
}
