(function () {
  const MAX_ANCHOR_SECONDS = 12;
  const OVERLAP_TOLERANCE_SECONDS = 0.12;

  function alignedSubtitlePair(chineseJson, englishJson, time) {
    const englishEntry = findSubtitleEntryAt(englishJson, time);
    const english = subtitleContent(englishEntry);
    if (!englishEntry || !english) {
      return {
        chinese: findSubtitleAt(chineseJson, time),
        english: null,
        anchored: false
      };
    }

    const duration = subtitleTime(englishEntry.to) - subtitleTime(englishEntry.from);
    if (!(duration > 0) || duration > MAX_ANCHOR_SECONDS) {
      return {
        chinese: findSubtitleAt(chineseJson, time),
        english,
        anchored: false
      };
    }

    const chinese = mergedOverlappingChinese(chineseJson, englishEntry) || findSubtitleAt(chineseJson, time);
    return { chinese, english, anchored: Boolean(chinese) };
  }

  function mergedOverlappingChinese(chineseJson, anchor) {
    if (!Array.isArray(chineseJson)) return null;
    const from = subtitleTime(anchor.from) - OVERLAP_TOLERANCE_SECONDS;
    const to = subtitleTime(anchor.to) + OVERLAP_TOLERANCE_SECONDS;
    const chunks = [];
    for (const item of chineseJson) {
      if (!subtitleOverlaps(item, from, to)) continue;
      const content = normalizeSubtitleChunk(item?.content);
      if (!content) continue;
      if (chunks[chunks.length - 1] === content) continue;
      chunks.push(content);
    }
    return chunks.join("") || null;
  }

  function subtitleOverlaps(item, from, to) {
    const itemFrom = subtitleTime(item?.from);
    const itemTo = subtitleTime(item?.to);
    if (!(itemTo >= itemFrom)) return false;
    const midpoint = itemFrom + ((itemTo - itemFrom) / 2);
    return midpoint >= from && midpoint <= to;
  }

  function findSubtitleAt(subtitleJson, time) {
    const entry = findSubtitleEntryAt(subtitleJson, time);
    return subtitleContent(entry);
  }

  function findSubtitleEntryAt(subtitleJson, time) {
    if (!Array.isArray(subtitleJson)) return null;
    return subtitleJson.find((item) => time >= subtitleTime(item?.from) && time <= subtitleTime(item?.to)) || null;
  }

  function subtitleContent(entry) {
    return normalizeSubtitleChunk(entry?.content) || null;
  }

  function normalizeSubtitleChunk(text) {
    return String(text || "").replace(/\r/g, "").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("");
  }

  function subtitleTime(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  globalThis.IntentVideoSubtitleAlign = {
    alignedSubtitlePair,
    findSubtitleAt,
    findSubtitleEntryAt,
    mergedOverlappingChinese
  };
})();
