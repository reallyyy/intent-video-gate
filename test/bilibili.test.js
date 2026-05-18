import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBilibiliThumbnailUrl, thumbnailProxyPath } from "../src/bilibili.js";

test("normalizes Bilibili thumbnail URLs for local proxying", () => {
  assert.equal(
    normalizeBilibiliThumbnailUrl("http://i2.hdslb.com/bfs/archive/example.jpg"),
    "https://i2.hdslb.com/bfs/archive/example.jpg"
  );
  assert.equal(
    normalizeBilibiliThumbnailUrl("//i0.hdslb.com/bfs/archive/example.jpg@672w_378h_1c"),
    "https://i0.hdslb.com/bfs/archive/example.jpg@672w_378h_1c"
  );
  assert.equal(normalizeBilibiliThumbnailUrl("https://example.com/nope.jpg"), "");
});

test("builds Bilibili thumbnail proxy paths only for allowed image hosts", () => {
  assert.equal(
    thumbnailProxyPath("https://i0.hdslb.com/bfs/archive/example.jpg"),
    "/api/bilibili/thumbnail?url=https%3A%2F%2Fi0.hdslb.com%2Fbfs%2Farchive%2Fexample.jpg"
  );
  assert.equal(thumbnailProxyPath("https://example.com/nope.jpg"), "");
});
