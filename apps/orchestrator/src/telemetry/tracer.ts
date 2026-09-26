import type { TraceEvent } from "../../../../packages/contracts/src/index.js";
import { id } from "../lib/id.js";

export interface TraceSink {
  append(event: TraceEvent): Promise<void>;
  list(runId: string): Promise<TraceEvent[]>;
}

export class Tracer {
  private sequence = 0;
  constructor(private readonly runId: string, private readonly sink: TraceSink) {}

  async emit(event: Omit<TraceEvent, "eventId" | "runId" | "sequence" | "time">): Promise<TraceEvent> {
    const full: TraceEvent = {
      eventId: id("evt"),
      runId: this.runId,
      sequence: ++this.sequence,
      time: new Date().toISOString(),
      ...event
    };
    await this.sink.append(full);
    return full;
  }
}
