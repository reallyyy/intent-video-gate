import test from "node:test";
import assert from "node:assert/strict";
import { classifyBrowserNavigation, parseVideoUrl } from "../src/rules.js";

test("parses YouTube watch URLs", () => {
  assert.deepEqual(parseVideoUrl("https://www.youtube.com/watch?v=abc123&list=nope"), {
    platform: "youtube",
    id: "abc123",
    canonicalUrl: "https://www.youtube.com/watch?v=abc123"
  });
});

test("parses youtu.be URLs", () => {
  assert.equal(parseVideoUrl("https://youtu.be/abc123").canonicalUrl, "https://www.youtube.com/watch?v=abc123");
});

test("parses Bilibili video URLs", () => {
  assert.deepEqual(parseVideoUrl("https://www.bilibili.com/video/BV1xx411c7mD/?spm_id=1"), {
    platform: "bilibili",
    id: "BV1xx411c7mD",
    canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD"
  });
});

test("blocks feed-like navigation", () => {
  assert.equal(classifyBrowserNavigation("https://www.youtube.com/").action, "block");
  assert.equal(classifyBrowserNavigation("https://www.youtube.com/results?search_query=rust").action, "block");
  assert.equal(classifyBrowserNavigation("https://www.youtube.com/gaming").action, "block");
  assert.equal(classifyBrowserNavigation("https://gaming.youtube.com/").action, "block");
  assert.equal(classifyBrowserNavigation("https://www.bilibili.com/v/popular/all").action, "block");
  assert.equal(classifyBrowserNavigation("https://www.bilibili.com/v/game").action, "block");
  assert.equal(classifyBrowserNavigation("https://game.bilibili.com/").action, "block");
});

test("redirects direct video navigation", () => {
  assert.equal(classifyBrowserNavigation("https://www.youtube.com/watch?v=abc123").action, "redirect");
  assert.equal(classifyBrowserNavigation("https://www.bilibili.com/video/BV1xx411c7mD").action, "redirect");
});

test("ignores unrelated pages", () => {
  assert.equal(classifyBrowserNavigation("https://example.com/watch?v=abc123").action, "ignore");
});

test("allows platform history pages for verification", () => {
  assert.equal(classifyBrowserNavigation("https://www.youtube.com/feed/history").action, "ignore");
  assert.equal(classifyBrowserNavigation("https://www.bilibili.com/account/history").action, "ignore");
});

test("allows sign-in and account pages", () => {
  assert.equal(classifyBrowserNavigation("https://www.youtube.com/signin?action_handle_signin=true").action, "ignore");
  assert.equal(classifyBrowserNavigation("https://accounts.google.com/ServiceLogin?continue=https://www.youtube.com/").action, "ignore");
  assert.equal(classifyBrowserNavigation("https://myaccount.google.com/").action, "ignore");
  assert.equal(classifyBrowserNavigation("https://passport.bilibili.com/login").action, "ignore");
  assert.equal(classifyBrowserNavigation("https://account.bilibili.com/account/home").action, "ignore");
  assert.equal(classifyBrowserNavigation("https://www.bilibili.com/login").action, "ignore");
});
