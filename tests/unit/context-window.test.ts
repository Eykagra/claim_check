import test from "node:test";
import assert from "node:assert/strict";
import { buildExtractionWindow } from "../../apps/extension/src/shared/context-window.js";

const segment = (id: string, text: string, startMs: number) => ({ id, text, startMs, endMs: startMs + 1000, confidence: 0.95, speaker: null, isFinal: true });

test("short STT fragments are grouped into a multi-sentence context window", () => {
  const input = [
    segment("1", "The unemployment rate", 0),
    segment("2", "fell below four percent last year.", 1000),
    segment("3", "That was the lowest level", 2000),
    segment("4", "recorded in more than a decade.", 3000),
    segment("5", "The labor department published the figures.", 4000)
  ];
  const window = buildExtractionWindow(input, 0, { minTotalWords: 20, minNewWords: 10 });
  assert.equal(window.ready, true);
  assert.ok(window.sentenceCount >= 2 && window.sentenceCount <= 4);
  assert.match(window.segments.map((item) => item.text).join(" "), /unemployment rate fell below four percent/i);
});

test("a tiny fragment is not sent to the claim extractor", () => {
  const window = buildExtractionWindow([segment("1", "below four percent", 0)], 0);
  assert.equal(window.ready, false);
});
