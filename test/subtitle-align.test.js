import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;

async function helper() {
  const source = await readFile(join(root, "extension/subtitle-align.js"), "utf8");
  const context = vm.createContext({ globalThis: {} });
  vm.runInContext(source, context);
  return context.globalThis.IntentVideoSubtitleAlign;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("subtitle alignment merges Chinese chunks across the active English cue", async () => {
  const align = await helper();
  const chinese = [
    { from: 0.8, to: 1.1, content: "上一句" },
    { from: 1.2, to: 1.8, content: "这是" },
    { from: 1.8, to: 2.4, content: "一个" },
    { from: 2.4, to: 3.0, content: "测试" },
    { from: 3.6, to: 4.0, content: "下一句" }
  ];
  const english = [
    { from: 1.15, to: 3.05, content: "This is a test." }
  ];

  assert.deepEqual(plain(align.alignedSubtitlePair(chinese, english, 1.3)), {
    chinese: "这是一个测试",
    english: "This is a test.",
    anchored: true
  });
  assert.deepEqual(plain(align.alignedSubtitlePair(chinese, english, 2.8)), {
    chinese: "这是一个测试",
    english: "This is a test.",
    anchored: true
  });
});

test("subtitle alignment excludes chunks outside the English cue tolerance", async () => {
  const align = await helper();
  const chinese = [
    { from: 0.0, to: 0.9, content: "太早" },
    { from: 1.1, to: 1.5, content: "保留" },
    { from: 2.5, to: 2.9, content: "这些" },
    { from: 3.4, to: 4.0, content: "太晚" }
  ];
  const english = [{ from: 1.0, to: 3.0, content: "Keep these." }];

  assert.equal(align.alignedSubtitlePair(chinese, english, 2).chinese, "保留这些");
});

test("subtitle alignment falls back when there is no active English cue", async () => {
  const align = await helper();
  const pair = align.alignedSubtitlePair(
    [{ from: 5, to: 6, content: "中文" }],
    [{ from: 1, to: 2, content: "English" }],
    5.5
  );

  assert.deepEqual(plain(pair), { chinese: "中文", english: null, anchored: false });
});

test("subtitle alignment does not merge a whole track for overlong English cues", async () => {
  const align = await helper();
  const chinese = [
    { from: 1, to: 2, content: "当前" },
    { from: 10, to: 11, content: "不应合并" }
  ];
  const english = [{ from: 0, to: 60, content: "An overlong cue." }];

  assert.deepEqual(plain(align.alignedSubtitlePair(chinese, english, 1.5)), {
    chinese: "当前",
    english: "An overlong cue.",
    anchored: false
  });
});
