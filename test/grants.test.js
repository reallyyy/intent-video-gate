import test from "node:test";
import assert from "node:assert/strict";
import { createGrant, hasGrant } from "../src/grants.js";

test("grants canonical YouTube watch URLs", () => {
  const grant = createGrant("https://www.youtube.com/watch?v=abc123&feature=share", 10000);
  assert.equal(grant.url, "https://www.youtube.com/watch?v=abc123");
  assert.equal(hasGrant("https://youtu.be/abc123"), true);
});

test("grants expire", async () => {
  createGrant("https://www.bilibili.com/video/BV1xx411c7mD", 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(hasGrant("https://www.bilibili.com/video/BV1xx411c7mD"), false);
});

test("grants collector home pages", () => {
  createGrant("https://www.youtube.com/", 10000);
  assert.equal(hasGrant("https://www.youtube.com/"), true);
});
