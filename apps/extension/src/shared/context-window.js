const END_PUNCTUATION = /[.!?]["')\]]?$/;

export function buildExtractionWindow(segments, cursor, options = {}) {
  const minTotalWords = options.minTotalWords ?? 24;
  const minNewWords = options.minNewWords ?? 10;
  const maxSentences = options.maxSentences ?? 4;
  const targetWordsPerSentence = options.targetWordsPerSentence ?? 14;

  const finalSegments = segments.filter((segment) => segment?.isFinal && String(segment.text || "").trim());
  const safeCursor = Math.max(0, Math.min(cursor, finalSegments.length));
  const overlapStart = Math.max(0, safeCursor - 4);
  const candidates = finalSegments.slice(overlapStart);
  const newSegments = finalSegments.slice(safeCursor);
  const sentenceUnits = sentenceParts(candidates);
  const grouped = groupShortUnits(sentenceUnits, targetWordsPerSentence);
  const selected = grouped.slice(-maxSentences);
  const totalWords = countWords(selected.map((segment) => segment.text).join(" "));
  const newWords = countWords(newSegments.map((segment) => segment.text).join(" "));
  const explicitSentences = selected.filter((segment) => END_PUNCTUATION.test(segment.text.trim())).length;

  return {
    ready: newWords >= minNewWords && (totalWords >= minTotalWords || explicitSentences >= 2),
    segments: selected,
    nextCursor: finalSegments.length,
    totalWords,
    newWords,
    sentenceCount: selected.length
  };
}

function sentenceParts(segments) {
  const parts = [];
  for (const segment of segments) {
    const matches = String(segment.text).trim().match(/[^.!?]+[.!?]["')\]]?|[^.!?]+$/g) || [];
    for (const text of matches.map((value) => value.trim()).filter(Boolean)) {
      parts.push({
        id: `${segment.id}:${parts.length}`,
        text,
        startMs: Number(segment.startMs || 0),
        endMs: Number(segment.endMs || 0),
        confidence: typeof segment.confidence === "number" ? segment.confidence : null,
        speaker: segment.speaker ?? null,
        isFinal: true
      });
    }
  }
  return parts;
}

function groupShortUnits(units, targetWords) {
  const output = [];
  let pending = [];
  let pendingWords = 0;
  const flush = () => {
    if (!pending.length) return;
    const first = pending[0];
    const last = pending.at(-1);
    const confidences = pending.map((part) => part.confidence).filter((value) => typeof value === "number");
    const speakers = [...new Set(pending.map((part) => part.speaker).filter((value) => value != null))];
    output.push({
      id: `ctx:${first.id}:${last.id}`,
      text: pending.map((part) => part.text).join(" ").replace(/\s+/g, " ").trim(),
      startMs: first.startMs,
      endMs: last.endMs,
      confidence: confidences.length ? Math.min(...confidences) : null,
      speaker: speakers.length === 1 ? speakers[0] : null,
      isFinal: true
    });
    pending = [];
    pendingWords = 0;
  };

  for (const unit of units) {
    pending.push(unit);
    pendingWords += countWords(unit.text);
    if (END_PUNCTUATION.test(unit.text.trim()) || pendingWords >= targetWords) flush();
  }
  flush();
  return output;
}

function countWords(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}
