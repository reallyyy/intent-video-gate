import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;

test("watch flow does not create new tabs or windows", async () => {
  const files = [
    "public/app.js",
    "extension/content.js",
    "extension/background.js"
  ];
  const source = (await Promise.all(files.map((file) => readFile(join(root, file), "utf8")))).join("\n");

  assert.equal(source.includes("window.open"), false);
  assert.equal(source.includes("chrome.tabs.create"), false);
  assert.equal(source.includes("target = \"_blank\""), false);
  assert.equal(source.includes("target=\"_blank\""), false);
  assert.equal(source.includes("_blank"), false);
});

test("extension content script parses", async () => {
  const source = await readFile(join(root, "extension/content.js"), "utf8");
  assert.doesNotThrow(() => new vm.Script(source));
});
