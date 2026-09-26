import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import path from "node:path";
import type { RunState, TraceEvent } from "../../../../packages/contracts/src/index.js";
import type { TraceSink } from "../telemetry/tracer.js";

export interface RunStore {
  save(state: RunState): Promise<void>;
  load(runId: string): Promise<RunState | null>;
}

export class FileRunStore implements RunStore, TraceSink {
  constructor(private readonly root: string) {}

  private runDir(runId: string): string { return path.join(this.root, "runs", runId); }

  async save(state: RunState): Promise<void> {
    const dir = this.runDir(state.runId);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, "state.json");
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await rename(temp, target);
  }

  async load(runId: string): Promise<RunState | null> {
    try {
      return JSON.parse(await readFile(path.join(this.runDir(runId), "state.json"), "utf8")) as RunState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async append(event: TraceEvent): Promise<void> {
    const dir = this.runDir(event.runId);
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "trace.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  }

  async list(runId: string): Promise<TraceEvent[]> {
    try {
      const raw = await readFile(path.join(this.runDir(runId), "trace.jsonl"), "utf8");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export class MemoryStore implements RunStore, TraceSink {
  readonly states = new Map<string, RunState>();
  readonly traces = new Map<string, TraceEvent[]>();
  async save(state: RunState): Promise<void> { this.states.set(state.runId, structuredClone(state)); }
  async load(runId: string): Promise<RunState | null> { return structuredClone(this.states.get(runId) ?? null); }
  async append(event: TraceEvent): Promise<void> { this.traces.set(event.runId, [...(this.traces.get(event.runId) ?? []), structuredClone(event)]); }
  async list(runId: string): Promise<TraceEvent[]> { return structuredClone(this.traces.get(runId) ?? []); }
}
