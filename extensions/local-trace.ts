import * as fs from "node:fs";
import * as path from "node:path";

export interface LocalTraceEvent {
  ts: string;
  pid: number;
  source: string;
  type: string;
  [key: string]: unknown;
}

/** Resolve the flight-recorder JSONL file path when tracing is enabled or configured. */
export function resolveTraceFilePath(): string | null {
  const explicit = String(process.env.PI_LOCAL_TRACE_FILE || "").trim();
  if (explicit) return explicit;
  if (String(process.env.PI_LOCAL_TRACE || "").trim() === "1") {
    return path.join("/tmp", "pi-local-traces", `session-${process.pid}.jsonl`);
  }
  return null;
}

/** Append one structured JSONL telemetry event safely without throwing or logging secrets. */
export function appendLocalTrace(
  source: string,
  type: string,
  fields: Record<string, unknown> = {},
): void {
  const tracePath = resolveTraceFilePath();
  if (!tracePath) return;
  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    const record: LocalTraceEvent = {
      ts: new Date().toISOString(),
      pid: process.pid,
      source,
      type,
      ...fields,
    };
    fs.appendFileSync(tracePath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch {
    // Ignore trace filesystem errors so observability never disrupts agent execution.
  }
}
