import type { TranscriptSegment } from "../../../../packages/contracts/src/index.js";
export interface ExtractionWindow {
  ready: boolean;
  segments: TranscriptSegment[];
  nextCursor: number;
  totalWords: number;
  newWords: number;
  sentenceCount: number;
}
export function buildExtractionWindow(segments: TranscriptSegment[], cursor: number, options?: {
  minTotalWords?: number;
  minNewWords?: number;
  maxSentences?: number;
  targetWordsPerSentence?: number;
}): ExtractionWindow;
