import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendLocalTrace } from "./local-trace.ts";

interface AdaptiveEscalationState {
  offset: number;
  errorStreak: number;
  cleanStreak: number;
  criticPending?: boolean;
}

function updateEscalationSignal(kind: "error" | "clean"): void {
  const g = globalThis as typeof globalThis & { __piLocalEscalation?: AdaptiveEscalationState };
  const st = g.__piLocalEscalation ?? (g.__piLocalEscalation = { offset: 0, errorStreak: 0, cleanStreak: 0 });
  if (kind === "error") {
    st.errorStreak += 1;
    st.cleanStreak = 0;
    if (st.errorStreak >= 2 && st.offset < 2) {
      st.offset += 1;
      st.errorStreak = 0;
    }
  } else {
    st.cleanStreak += 1;
    st.errorStreak = 0;
    if (st.cleanStreak >= 2 && st.offset > 0) {
      st.offset -= 1;
      st.cleanStreak = 0;
    }
  }
}

const DEFAULT_MAX_TOOL_CHARS = Number(process.env.PI_LOCAL_MAX_TOOL_CHARS || 6000);
const DEFAULT_MAX_TOOL_LINES = Number(process.env.PI_LOCAL_MAX_TOOL_LINES || 120);
const DEFAULT_MAX_SED_CHARS = Number(process.env.PI_LOCAL_MAX_SED_CHARS || 12000);
const DEFAULT_MAX_SED_LINES = Number(process.env.PI_LOCAL_MAX_SED_LINES || 220);
const DEFAULT_MAX_READ_CHARS = Number(process.env.PI_LOCAL_MAX_READ_CHARS || 20000);
const DEFAULT_MAX_READ_LINES = Number(process.env.PI_LOCAL_MAX_READ_LINES || 400);
const DEFAULT_MAX_EXEMPT_DOC_CHARS = Number(process.env.PI_LOCAL_MAX_EXEMPT_DOC_CHARS || 36000);

const GUARDED_SHELL_TOOLS = new Set(["bash", "powershell", "grep", "find", "ls"]);
const EXEMPT_DOC_PATH_RE =
  /(?:^|\/)(?:SKILL|PROMPT|AGENTS|CLAUDE|notes)\.md\b|\.pi-handoff(?:\.last)?\.md\b|\/(?:skills|skills-shared|skillshare|prompts)\/[^\s'"]*|\/reference\/[^\s'"]+\.md\b/i;
const SHELL_READ_CMD_RE = /\b(?:cat|head|tail|sed|bat|less)\b/;
const EXPLICIT_SED_SLICE_RE = /^\s*sed\s+-n\s+['"]?\d+,\d+p['"]?\s+\S+/;

function isExemptInstructionTarget(
  toolName: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (!input) return false;
  if (toolName === "read") {
    const filePath = String(input.path ?? input.file_path ?? "");
    return EXEMPT_DOC_PATH_RE.test(filePath);
  }
  if (toolName === "bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    return SHELL_READ_CMD_RE.test(cmd) && EXEMPT_DOC_PATH_RE.test(cmd);
  }
  return false;
}

function isExplicitLineSliceCommand(
  toolName: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (toolName !== "bash" || !input) return false;
  const cmd = typeof input.command === "string" ? input.command : "";
  return EXPLICIT_SED_SLICE_RE.test(cmd);
}

function slugifyCwd(cwd: string): string {
  const cleaned = cwd.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(-60) || "workspace";
}

function spillLogToDisk(
  cwd: string,
  toolName: string,
  toolCallId: string,
  fullText: string,
): string | null {
  try {
    const dir = path.join(os.tmpdir(), "pi-local-tool-logs", slugifyCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const safeId = (toolCallId || "call").replace(/[^a-zA-Z0-9_-]+/g, "").slice(-16) || "call";
    const filename = `${Date.now()}-${toolName}-${safeId}.log`;
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, fullText, "utf-8");
    return fullPath;
  } catch {
    return null;
  }
}

function trimWithHeadAndTail(
  fullText: string,
  headLines: number,
  tailLines: number,
  maxChars: number,
): { snippet: string; totalLines: number; omittedLines: number } {
  const lines = fullText.split(/\r?\n/);
  const totalLines = lines.length;

  let headText = "";
  let tailText = "";
  let omittedLines = 0;

  if (totalLines > headLines + tailLines + 5) {
    const head = lines.slice(0, headLines);
    const tail = lines.slice(-tailLines);
    omittedLines = totalLines - head.length - tail.length;
    headText = head.join("\n");
    tailText = tail.join("\n");
  } else {
    const half = Math.max(400, Math.floor((maxChars - 200) / 2));
    headText = fullText.slice(0, half);
    tailText = fullText.slice(-half);
  }

  const budgetHead = Math.floor((maxChars - 300) * 0.45);
  const budgetTail = Math.floor((maxChars - 300) * 0.55);
  if (headText.length > budgetHead) {
    headText = `${headText.slice(0, Math.max(200, budgetHead))}\n... [head truncated]`;
  }
  if (tailText.length > budgetTail) {
    tailText = `[tail truncated] ...\n${tailText.slice(-Math.max(200, budgetTail))}`;
  }

  const marker =
    omittedLines > 0
      ? `\n\n... [${omittedLines} middle lines omitted for local speed] ...\n\n`
      : `\n\n... [middle output omitted for local speed] ...\n\n`;

  return {
    snippet: `${headText}${marker}${tailText}`,
    totalLines,
    omittedLines,
  };
}

function summarizeCallSignature(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return toolName;
  try {
    const hash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
    return `${toolName}:${hash}`;
  } catch {
    return toolName;
  }
}

const HARD_HEREDOC_CHARS = Number(process.env.PI_LOCAL_HARD_HEREDOC_CHARS || 1000);
const NOTES_APPEND_MAX_CHARS = Number(process.env.PI_LOCAL_NOTES_HEREDOC_CHARS || 2500);
const HARD_PYTHON_INLINE_CHARS = Number(process.env.PI_LOCAL_HARD_PYTHON_INLINE_CHARS || 800);
const HARD_PYTHON_PROBE_STREAK = Number(process.env.PI_LOCAL_HARD_PYTHON_STREAK || 5);
const INLINE_PROBE_STREAK_WARN = Number(process.env.PI_LOCAL_INLINE_PROBE_WARN || 3);

function isTmpScratchPythonWrite(toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (toolName !== "write" || !input) return false;
  const p = String(input.path ?? input.file_path ?? "");
  return /^\/(?:private\/)?(?:var\/)?tmp\/.*\.py$/i.test(p);
}

function isHeredocCommand(toolName: string, input: Record<string, unknown> | undefined): { isHeredoc: boolean; length: number } {
  if (toolName !== "bash" || !input) return { isHeredoc: false, length: 0 };
  const cmd = typeof input.command === "string" ? input.command : "";
  return {
    isHeredoc: /<<['"]?[A-Za-z0-9_]+['"]?/.test(cmd),
    length: cmd.length,
  };
}

function isNotesAppendHeredoc(toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (toolName !== "bash" || !input) return false;
  const cmd = typeof input.command === "string" ? input.command : "";
  return /^\s*cat\s+>>\s*(?:\.\/)?notes\.md\s+<<['"]?[A-Za-z0-9_]+['"]?/.test(cmd);
}

function isLargeHeredocCommand(toolName: string, input: Record<string, unknown> | undefined): boolean {
  const info = isHeredocCommand(toolName, input);
  if (!info.isHeredoc) return false;
  if (isNotesAppendHeredoc(toolName, input)) return false;
  return info.length >= 400;
}

function isHardBlockedHeredocCommand(toolName: string, input: Record<string, unknown> | undefined): boolean {
  const info = isHeredocCommand(toolName, input);
  if (!info.isHeredoc) return false;
  if (isNotesAppendHeredoc(toolName, input)) {
    return info.length >= NOTES_APPEND_MAX_CHARS;
  }
  return info.length >= HARD_HEREDOC_CHARS;
}

function isPythonInlineProbe(toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (toolName !== "bash" || !input) return false;
  const cmd = typeof input.command === "string" ? input.command.trim() : "";
  return Boolean(cmd && /\bpython3?\s+-c\b/.test(cmd));
}

function isShellReadProbe(toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (toolName !== "bash" || !input) return false;
  const cmd = typeof input.command === "string" ? input.command.trim() : "";
  if (!cmd) return false;
  if (isExplicitLineSliceCommand(toolName, input)) return false;
  if (/(?:^|\s)(?:\.\/)?notes\.md(?:\s|$)/.test(cmd)) return false;
  return /^\s*(?:cat|head|tail|sed)\b/.test(cmd);
}

const MAX_REPAIR_FILE_BYTES = 2_097_152;
const SLOW_BASH_MS = Number(process.env.PI_LOCAL_SLOW_BASH_MS || 60000);
const MAX_PREMATURE_RETRIES = 2;
const AGENT_BROWSER_EVAL_BATCH_NUDGE = Number(process.env.PI_LOCAL_AB_EVAL_NUDGE || 6);
const VERIFY_SCRIPT_CMD_RE =
  /(?:^|[\s/])(?:_?verify|verify_|_?harness|test_)[a-zA-Z0-9_.-]*\.(?:js|mjs|cjs|py)\b/i;

export interface AssistantTurnSnapshot {
  stopReason?: string;
  toolCallCount: number;
  visibleText: string;
  thinkingChars: number;
  hadToolCallsInSession: boolean;
}

/** Detect when a local model stops mid-task (blank output after thinking, or announced intent without a tool call). */
export function detectPrematureStop(
  snapshot: AssistantTurnSnapshot,
): "empty_after_thinking" | "announced_intent" | null {
  if (!snapshot.hadToolCallsInSession || snapshot.toolCallCount > 0) return null;
  const stop = String(snapshot.stopReason || "").toLowerCase();
  if (stop !== "stop" && stop !== "length") return null;
  const trimmed = snapshot.visibleText.trim();
  if (trimmed.length === 0) {
    return "empty_after_thinking";
  }
  if (
    trimmed.length <= 400 &&
    (trimmed.endsWith(":") ||
      /\b(?:let me|now i(?:'ll| will)|i(?:'ll| will) now|next,?\s+i(?:'ll| will)|i am going to)\b[^.?!]{0,140}(?::|\.\.\.)?\s*$/i.test(
        trimmed,
      ))
  ) {
    return "announced_intent";
  }
  return null;
}

/** Extract named agent-browser sessions opened or closed by a bash command. */
export function extractAgentBrowserSessions(cmd: string): { opened: string[]; closed: string[] } {
  const opened: string[] = [];
  const closed: string[] = [];
  if (!cmd || !/\bagent-browser\b/.test(cmd)) return { opened, closed };
  const sessionMatch = cmd.match(/\bAGENT_BROWSER_SESSION=(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.:-]+))/);
  const sess = sessionMatch ? (sessionMatch[1] ?? sessionMatch[2] ?? sessionMatch[3] ?? "").trim() : "";
  if (!sess) return { opened, closed };
  if (/\bagent-browser\b[^\n;&|]*\bclose\b/.test(cmd)) {
    closed.push(sess);
  } else if (/\bagent-browser\b[^\n;&|]*\bopen\b/.test(cmd)) {
    opened.push(sess);
  }
  return { opened, closed };
}

function resolveWorkspacePath(filePath: string, cwd: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

function tryParseJsonObjectOrArray(raw: string): unknown {
  let cleaned = raw.trim();
  if (!cleaned) return null;
  const fence = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (fence) {
    cleaned = fence[1].trim();
  }
  const attempts = [cleaned, cleaned.replace(/,\s*([}\]])/g, "$1")];
  if (cleaned.includes('"""')) {
    const fixedTriple = cleaned
      .replace(/:\s*"""([\s\S]*?)"""(?=\s*[,}\]])/g, (_m, inner: string) => `: ${JSON.stringify(inner)}`)
      .replace(/,\s*([}\]])/g, "$1");
    attempts.push(fixedTriple);
  }
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next fallback
    }
  }
  return null;
}

function parseXmlEditString(raw: string): { oldText: string; newText: string } | null {
  const oldMatch = raw.match(/<oldText>([\s\S]*?)<\/oldText>|<old_text>([\s\S]*?)<\/old_text>/i);
  const newMatch = raw.match(/<newText>([\s\S]*?)<\/newText>|<new_text>([\s\S]*?)<\/new_text>/i);
  if (!oldMatch || !newMatch) return null;
  return {
    oldText: oldMatch[1] ?? oldMatch[2] ?? "",
    newText: newMatch[1] ?? newMatch[2] ?? "",
  };
}

function normalizeEditItem(item: unknown): { value: Record<string, unknown> | null; changed: boolean } {
  let obj: unknown = item;
  let changed = false;
  if (typeof item === "string") {
    const parsed = tryParseJsonObjectOrArray(item);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, changed: false };
    }
    obj = parsed;
    changed = true;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { value: null, changed: false };
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.oldText !== "string") {
    const aliasOld = typeof rec.old_text === "string" ? rec.old_text : typeof rec.old_string === "string" ? rec.old_string : null;
    if (aliasOld !== null) {
      rec.oldText = aliasOld;
      changed = true;
    }
  }
  if (typeof rec.newText !== "string") {
    const aliasNew = typeof rec.new_text === "string" ? rec.new_text : typeof rec.new_string === "string" ? rec.new_string : null;
    if (aliasNew !== null) {
      rec.newText = aliasNew;
      changed = true;
    }
  }
  return { value: rec, changed };
}

function countLiteralOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count += 1;
    idx = found + needle.length;
  }
  return count;
}

function splitLinesWithEol(text: string): { text: string; eol: string; start: number }[] {
  const out: { text: string; eol: string; start: number }[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[0] === "" && re.lastIndex >= text.length) break;
    out.push({ text: match[1], eol: match[2], start: match.index });
    if (match[0] === "") break;
  }
  return out;
}

function leadingSpaces(line: string): string {
  const m = line.match(/^([ \t]*)/);
  return m ? m[1] : "";
}

function shiftBlockIndent(text: string, oldNonEmpty: string[], diskNonEmpty: string[]): string {
  if (oldNonEmpty.length === 0 || oldNonEmpty.length !== diskNonEmpty.length) return text;
  const oldIndent0 = leadingSpaces(oldNonEmpty[0]);
  const diskIndent0 = leadingSpaces(diskNonEmpty[0]);
  const oldSpacesOnly = /^[ ]*$/.test(oldIndent0) && /^[ ]*$/.test(diskIndent0);
  if (!oldSpacesOnly) return text;
  const delta = diskIndent0.length - oldIndent0.length;
  if (delta === 0) return text;
  for (let i = 1; i < oldNonEmpty.length; i++) {
    const d = leadingSpaces(diskNonEmpty[i]).length - leadingSpaces(oldNonEmpty[i]).length;
    if (!/^[ ]*$/.test(leadingSpaces(oldNonEmpty[i])) || !/^[ ]*$/.test(leadingSpaces(diskNonEmpty[i])) || d !== delta) {
      return text;
    }
  }
  return text
    .split(/(\r\n|\n)/)
    .map((part) => {
      if (part === "\n" || part === "\r\n" || part.trim() === "") return part;
      if (delta > 0) return " ".repeat(delta) + part;
      const rm = Math.min(-delta, leadingSpaces(part).length);
      return part.slice(rm);
    })
    .join("");
}

/** Repair stringified or XML edit arguments and recover unique whitespace/line-ending mismatches safely. */
export function repairEditArguments(args: Record<string, unknown>, cwd: string): boolean {
  let changed = false;

  if (args.edits === undefined && typeof args.edit === "string") {
    const xmlPair = parseXmlEditString(args.edit);
    if (xmlPair) {
      args.edits = [xmlPair];
      delete args.edit;
      changed = true;
    } else {
      const parsed = tryParseJsonObjectOrArray(args.edit);
      if (Array.isArray(parsed)) {
        args.edits = parsed;
        delete args.edit;
        changed = true;
      } else if (parsed && typeof parsed === "object") {
        args.edits = [parsed];
        delete args.edit;
        changed = true;
      }
    }
  }

  if (typeof args.edits === "string") {
    const parsed = tryParseJsonObjectOrArray(args.edits);
    if (Array.isArray(parsed)) {
      args.edits = parsed;
      changed = true;
    } else if (parsed && typeof parsed === "object") {
      args.edits = [parsed];
      changed = true;
    }
  }

  if (Array.isArray(args.edits)) {
    const nextEdits: unknown[] = [];
    for (const item of args.edits) {
      const norm = normalizeEditItem(item);
      if (norm.value) {
        nextEdits.push(norm.value);
        if (norm.changed) changed = true;
      } else {
        nextEdits.push(item);
      }
    }
    args.edits = nextEdits;
  } else {
    const normTop = normalizeEditItem(args);
    if (normTop.changed) changed = true;
  }

  const filePath = String(args.path ?? args.file_path ?? "");
  const absPath = resolveWorkspacePath(filePath, cwd);
  if (!absPath) return changed;

  let diskText = "";
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_REPAIR_FILE_BYTES) return changed;
    diskText = fs.readFileSync(absPath, "utf-8");
  } catch {
    return changed;
  }

  const editTargets: Record<string, unknown>[] = [];
  if (Array.isArray(args.edits)) {
    for (const entry of args.edits) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const rec = entry as Record<string, unknown>;
        if (typeof rec.oldText === "string" && typeof rec.newText === "string") {
          editTargets.push(rec);
        }
      }
    }
  } else if (typeof args.oldText === "string" && typeof args.newText === "string") {
    editTargets.push(args);
  }

  const diskSegs = splitLinesWithEol(diskText);
  const diskUsesCrlf = diskText.includes("\r\n");

  for (const edit of editTargets) {
    const oldText = edit.oldText as string;
    const newText = edit.newText as string;
    if (!oldText || diskText.includes(oldText)) continue;

    // Cascade 1: unique CRLF <-> LF line-ending match.
    const normDisk = diskText.replace(/\r\n/g, "\n");
    const normOld = oldText.replace(/\r\n/g, "\n");
    if (normOld && countLiteralOccurrences(normDisk, normOld) === 1) {
      const normSegs = splitLinesWithEol(normDisk);
      const matchStart = normDisk.indexOf(normOld);
      const matchEnd = matchStart + normOld.length;
      let startIdx = -1;
      let endIdx = -1;
      for (let i = 0; i < normSegs.length && i < diskSegs.length; i++) {
        const nStart = normSegs[i].start;
        const nEnd = nStart + normSegs[i].text.length + normSegs[i].eol.length;
        if (startIdx === -1 && matchStart >= nStart && (matchStart < nEnd || i === normSegs.length - 1)) {
          startIdx = diskSegs[i].start + (matchStart - nStart);
        }
        if (matchEnd >= nStart && matchEnd <= nEnd) {
          endIdx = diskSegs[i].start + Math.min(matchEnd - nStart, diskSegs[i].text.length + diskSegs[i].eol.length);
          break;
        }
      }
      if (startIdx >= 0 && endIdx > startIdx) {
        const exactSlice = diskText.slice(startIdx, endIdx);
        if (exactSlice && countLiteralOccurrences(diskText, exactSlice) === 1) {
          edit.oldText = exactSlice;
          if (diskUsesCrlf && !newText.includes("\r\n")) {
            edit.newText = newText.replace(/\n/g, "\r\n");
          } else if (!diskUsesCrlf && newText.includes("\r\n")) {
            edit.newText = newText.replace(/\r\n/g, "\n");
          }
          changed = true;
          continue;
        }
      }
    }

    // Cascade 2: unique contiguous trimmed-line block match.
    const endedWithNewline = /\r?\n$/.test(oldText);
    const oldLines = oldText.split(/\r?\n/);
    if (endedWithNewline) oldLines.pop();
    if (oldLines.length >= 1 && oldLines.some((l) => l.trim().length > 0)) {
      const matches: number[] = [];
      for (let s = 0; s <= diskSegs.length - oldLines.length; s++) {
        let ok = true;
        for (let k = 0; k < oldLines.length; k++) {
          if (diskSegs[s + k].text.trim() !== oldLines[k].trim()) {
            ok = false;
            break;
          }
        }
        if (ok) {
          matches.push(s);
          if (matches.length > 1) break;
        }
      }
      if (matches.length === 1) {
        const startSegIdx = matches[0];
        const endSegIdx = startSegIdx + oldLines.length - 1;
        const startByte = diskSegs[startSegIdx].start;
        const endByte =
          diskSegs[endSegIdx].start +
          diskSegs[endSegIdx].text.length +
          (endedWithNewline ? diskSegs[endSegIdx].eol.length : 0);
        const exactSlice = diskText.slice(startByte, endByte);
        if (exactSlice && countLiteralOccurrences(diskText, exactSlice) === 1) {
          const oldNonEmpty = oldLines.filter((l) => l.trim().length > 0);
          const diskNonEmpty = diskSegs
            .slice(startSegIdx, endSegIdx + 1)
            .map((seg) => seg.text)
            .filter((l) => l.trim().length > 0);
          edit.oldText = exactSlice;
          edit.newText = shiftBlockIndent(newText, oldNonEmpty, diskNonEmpty);
          changed = true;
          continue;
        }
      }
    }

    // Cascade 3: unique outer-whitespace trim match.
    const trimmedOld = oldText.trim();
    if (trimmedOld.length >= 8 && trimmedOld !== oldText && countLiteralOccurrences(diskText, trimmedOld) === 1) {
      edit.oldText = trimmedOld;
      const hadLeadingNl = /^\s*\n/.test(oldText) && /^\s*\n/.test(newText);
      const hadTrailingNl = /\n\s*$/.test(oldText) && /\n\s*$/.test(newText);
      if (hadLeadingNl || hadTrailingNl) {
        edit.newText = newText.trim();
      }
      changed = true;
      continue;
    }

    // Cascade 4: unique contiguous line-block match after single/double/backtick quote normalization.
    if (/['"`]/.test(oldText) && oldLines.length >= 1 && oldLines.some((l) => l.trim().length > 0)) {
      const normQuotes = (s: string): string => s.trim().replace(/['"`]/g, '"');
      const quoteMatches: number[] = [];
      for (let s = 0; s <= diskSegs.length - oldLines.length; s++) {
        let ok = true;
        for (let k = 0; k < oldLines.length; k++) {
          if (normQuotes(diskSegs[s + k].text) !== normQuotes(oldLines[k])) {
            ok = false;
            break;
          }
        }
        if (ok) {
          quoteMatches.push(s);
          if (quoteMatches.length > 1) break;
        }
      }
      if (quoteMatches.length === 1) {
        const startSegIdx = quoteMatches[0];
        const endSegIdx = startSegIdx + oldLines.length - 1;
        const startByte = diskSegs[startSegIdx].start;
        const endByte =
          diskSegs[endSegIdx].start +
          diskSegs[endSegIdx].text.length +
          (endedWithNewline ? diskSegs[endSegIdx].eol.length : 0);
        const exactSlice = diskText.slice(startByte, endByte);
        if (exactSlice && countLiteralOccurrences(diskText, exactSlice) === 1) {
          const oldNonEmpty = oldLines.filter((l) => l.trim().length > 0);
          const diskNonEmpty = diskSegs
            .slice(startSegIdx, endSegIdx + 1)
            .map((seg) => seg.text)
            .filter((l) => l.trim().length > 0);
          edit.oldText = exactSlice;
          edit.newText = shiftBlockIndent(newText, oldNonEmpty, diskNonEmpty);
          changed = true;
        }
      }
    }
  }

  return changed;
}

const SECRET_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: "AWS Access Key ID", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "PEM Private Key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { label: "GitHub Token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: "API Secret Key", regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/ },
];

/** Detect high-confidence hardcoded credentials before writing content to disk. */
export function detectHardcodedSecrets(text: string): string | null {
  if (!text) return null;
  for (const pat of SECRET_PATTERNS) {
    if (pat.regex.test(text)) {
      return pat.label;
    }
  }
  return null;
}

export interface FileLintResult {
  syntaxError: string | null;
  lintErrors: string[];
}

function runToolLines(cmd: string, args: string[], cwd: string): { ok: boolean; lines: string[]; raw: string } {
  try {
    execFileSync(cmd, args, {
      cwd,
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, lines: [], raw: "" };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { ok: true, lines: [], raw: "" };
    }
    const raw = String(err?.stdout || err?.stderr || err?.message || "Check failed").trim();
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return { ok: false, lines, raw };
  }
}

/** Run lightweight syntax + fast semantic lint checks (ruff / oxlint) on a modified file. */
export function lintFileIssues(filePath: string, cwd: string): FileLintResult {
  const absPath = resolveWorkspacePath(filePath, cwd);
  if (!absPath || !fs.existsSync(absPath)) {
    return { syntaxError: null, lintErrors: [] };
  }
  const ext = path.extname(absPath).toLowerCase();
  let syntaxError: string | null = null;
  const lintErrors: string[] = [];

  if (ext === ".py") {
    const pyCheck = runToolLines("python3", ["-m", "py_compile", absPath], cwd);
    if (!pyCheck.ok) {
      syntaxError = pyCheck.raw.length > 600 ? `${pyCheck.raw.slice(0, 600)}...` : pyCheck.raw;
    }
    const ruffRes = runToolLines(
      "ruff",
      ["check", "--select", "E9,F63,F7,F82,F841,F401", "--no-cache", "--output-format", "concise", absPath],
      cwd,
    );
    if (!ruffRes.ok) {
      for (const line of ruffRes.lines) {
        if (!/^Found \d+ error/i.test(line) && !/^\[\*\]/.test(line)) {
          lintErrors.push(line);
        }
      }
    }
  } else if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".mts") {
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      const nodeCheck = runToolLines("node", ["--check", absPath], cwd);
      if (!nodeCheck.ok) {
        syntaxError = nodeCheck.raw.length > 600 ? `${nodeCheck.raw.slice(0, 600)}...` : nodeCheck.raw;
      }
    }
    const oxlintRes = runToolLines("oxlint", ["--quiet", absPath], cwd);
    if (!oxlintRes.ok) {
      for (const line of oxlintRes.lines) {
        if (/^(?:×|x\s|error\b|\d+:\d+)/i.test(line) || line.includes(path.basename(absPath))) {
          lintErrors.push(line);
        }
      }
      if (lintErrors.length === 0 && oxlintRes.raw) {
        lintErrors.push(oxlintRes.raw.slice(0, 400));
      }
    }
  }

  return { syntaxError, lintErrors };
}

function defaultHasTimeoutBinary(): boolean {
  if (process.platform !== "darwin") return true;
  return (
    fs.existsSync("/opt/homebrew/bin/timeout") ||
    fs.existsSync("/usr/local/bin/timeout") ||
    fs.existsSync("/usr/bin/timeout")
  );
}

/** Strip missing GNU `timeout` prefix from macOS shell segments so bash does not exit 127. */
export function repairMacOsTimeoutCommand(cmd: string, hasTimeoutBin = defaultHasTimeoutBinary()): string {
  if (hasTimeoutBin || !cmd || !/\btimeout\b/.test(cmd)) return cmd;
  return cmd.replace(
    /(^|&&|\|\||;|\()\s*(?:command\s+)?timeout\s+(?:(?:-[a-zA-Z]|--[a-zA-Z0-9_-]+(?:=\S+)?)\s+(?:[^\s-]\S*\s+)?)*\d+(?:\.\d+)?[smhd]?\s+/g,
    (_m, sep: string) => (sep ? `${sep} ` : ""),
  );
}

/** Run lightweight compile-time syntax validation after Python or JS write/edit calls. */
export function checkSyntaxForFile(filePath: string, cwd: string): string | null {
  return lintFileIssues(filePath, cwd).syntaxError;
}

function isInsideGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Locate the closest anchor line when `edit` cannot find an exact `oldText` match. */
export function findClosestEditLineHint(filePath: string, oldText: string, cwd: string): string | null {
  const absPath = resolveWorkspacePath(filePath, cwd);
  if (!absPath || !oldText) return null;
  let diskLines: string[];
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_REPAIR_FILE_BYTES) return null;
    diskLines = fs.readFileSync(absPath, "utf-8").split(/\r?\n/);
  } catch {
    return null;
  }

  const candidates = oldText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (candidates.length === 0) return null;
  const ordered = [
    ...candidates.filter((l) => l.length >= 5).sort((a, b) => b.length - a.length),
    ...candidates.filter((l) => l.length < 5),
  ];

  let bestLine = -1;
  for (const cand of ordered) {
    for (let i = 0; i < diskLines.length; i++) {
      if (diskLines[i].trim() === cand) {
        bestLine = i + 1;
        break;
      }
    }
    if (bestLine > 0) break;
  }

  if (bestLine === -1) {
    const anchor = ordered[0];
    const anchorTokens = anchor.toLowerCase().split(/\W+/).filter((t) => t.length >= 2);
    if (anchorTokens.length > 0) {
      let bestScore = 0;
      for (let i = 0; i < diskLines.length; i++) {
        const lower = diskLines[i].toLowerCase();
        if (!lower.trim()) continue;
        let hits = 0;
        for (const tok of anchorTokens) {
          if (lower.includes(tok)) hits += 1;
        }
        const score = hits / anchorTokens.length;
        if (score >= 0.6 && score > bestScore) {
          bestScore = score;
          bestLine = i + 1;
        }
      }
    }
  }

  const total = diskLines.length;
  const rewriteTip = total <= 150
    ? `File is only ${total} lines: use write(path, content) to replace it cleanly if escaping keeps failing.`
    : `Inspect around there with read(path, offset, limit=35) before retrying edit.`;
  if (bestLine > 0) {
    return `[Edit recovery hint: Closest matching line in ${path.basename(absPath)} (${total} lines) is near line ${bestLine}. ${rewriteTip}]`;
  }
  return `[Edit recovery hint: Text not found in ${path.basename(absPath)} (${total} lines). ${rewriteTip}]`;
}

export default function localContextGuardExtension(pi: ExtensionAPI) {
  let consecutiveErrors = 0;
  let lastErrorSignature = "";
  let lastCallSignature = "";
  let consecutiveSameCall = 0;
  let consecutivePythonProbes = 0;
  let consecutiveShellReadProbes = 0;
  let consecutiveVerifyScriptErrors = 0;
  let consecutiveAgentBrowserEvals = 0;
  let hadToolCallsInSession = false;
  let consecutivePrematureRetries = 0;
  let lastAssistantSnapshot: Omit<AssistantTurnSnapshot, "hadToolCallsInSession"> | null = null;
  const bashStartTimes = new Map<string, number>();
  const baselineLintCounts = new Map<string, number>();
  const fileFailureStreak = new Map<string, number>();
  const openBrowserSessions = new Set<string>();

  function resetAllCounters(): void {
    consecutiveErrors = 0;
    lastErrorSignature = "";
    lastCallSignature = "";
    consecutiveSameCall = 0;
    consecutivePythonProbes = 0;
    consecutiveShellReadProbes = 0;
    consecutiveVerifyScriptErrors = 0;
    consecutiveAgentBrowserEvals = 0;
    consecutivePrematureRetries = 0;
    lastAssistantSnapshot = null;
    bashStartTimes.clear();
    baselineLintCounts.clear();
    fileFailureStreak.clear();
  }

  pi.on("session_start", () => {
    resetAllCounters();
    hadToolCallsInSession = false;
    openBrowserSessions.clear();
  });

  pi.on("input", () => {
    resetAllCounters();
  });

  // Run auto-repairs before Pi schema validation and track assistant completion state.
  pi.on("message_end", (event, ctx) => {
    const msg = event.message as { role?: string; stopReason?: string; content?: unknown[] } | undefined;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return;

    let repaired = false;
    let toolCallCount = 0;
    let thinkingChars = 0;
    const textParts: string[] = [];

    for (const part of msg.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const item = part as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
      if (item.type === "thinking" && typeof item.thinking === "string") {
        thinkingChars += item.thinking.length;
        continue;
      }
      if (item.type === "text" && typeof item.text === "string") {
        textParts.push(item.text);
        continue;
      }
      if (item.type !== "toolCall") continue;
      toolCallCount += 1;
      if (!item.arguments || typeof item.arguments !== "object" || Array.isArray(item.arguments)) {
        continue;
      }
      const args = item.arguments as Record<string, unknown>;
      if (item.name === "edit") {
        if (repairEditArguments(args, ctx.cwd)) {
          repaired = true;
          appendLocalTrace("local-context-guard", "tool_repair", { tool: "edit", path: String(args.path ?? args.file_path ?? "") });
        }
      } else if (item.name === "bash" && typeof args.command === "string") {
        const nextCmd = repairMacOsTimeoutCommand(args.command);
        if (nextCmd !== args.command) {
          args.command = nextCmd;
          repaired = true;
          appendLocalTrace("local-context-guard", "tool_repair", { tool: "bash", kind: "strip_timeout" });
        }
      }
    }

    lastAssistantSnapshot = {
      stopReason: msg.stopReason,
      toolCallCount,
      visibleText: textParts.join("\n"),
      thinkingChars,
    };

    return repaired ? { message: event.message as any } : undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    const toolName = String(event.toolName || "");
    hadToolCallsInSession = true;
    consecutivePrematureRetries = 0;
    if (toolName === "phase_handoff") {
      return;
    }
    const callId = String((event as { toolCallId?: string }).toolCallId || "last");
    if (toolName === "bash") {
      bashStartTimes.set(callId, Date.now());
    }
    const input = event.input as Record<string, unknown> | undefined;

    if (toolName === "write" || toolName === "edit") {
      if (process.env.PI_LOCAL_ALLOW_SECRETS !== "1") {
        const textsToScan: string[] = [];
        if (toolName === "write" && typeof input?.content === "string") {
          textsToScan.push(input.content);
        } else if (toolName === "edit" && input) {
          if (typeof input.newText === "string") textsToScan.push(input.newText);
          if (Array.isArray(input.edits)) {
            for (const entry of input.edits) {
              if (entry && typeof entry === "object") {
                const rec = entry as Record<string, unknown>;
                if (typeof rec.newText === "string") textsToScan.push(rec.newText);
                if (Array.isArray(rec.lines)) textsToScan.push(rec.lines.join("\n"));
              }
            }
          }
        }
        for (const candidate of textsToScan) {
          const foundSecret = detectHardcodedSecrets(candidate);
          if (foundSecret) {
            appendLocalTrace("local-context-guard", "secret_blocked", { tool: toolName, label: foundSecret });
            return {
              block: true,
              reason: `Security guard: blocked hardcoded ${foundSecret} before writing to disk. Read secrets from environment variables instead (or set PI_LOCAL_ALLOW_SECRETS=1 if intentional).`,
            };
          }
        }
      }

      const targetPath = String(input?.path ?? input?.file_path ?? "");
      if (targetPath && ctx?.cwd) {
        baselineLintCounts.set(callId, lintFileIssues(targetPath, ctx.cwd).lintErrors.length);
      }
    }
    const sig = summarizeCallSignature(toolName, input);
    if (sig === lastCallSignature) {
      consecutiveSameCall += 1;
    } else {
      lastCallSignature = sig;
      consecutiveSameCall = 1;
    }

    if (isTmpScratchPythonWrite(toolName, input)) {
      return {
        block: true,
        reason:
          "Local tool guard: do not write scratch Python scripts into /tmp. Write your real workspace deliverable (.py script in the current working directory) using write(path, content).",
      };
    }

    if (isPythonInlineProbe(toolName, input)) {
      const cmdLen = typeof input?.command === "string" ? input.command.length : 0;
      if (cmdLen >= HARD_PYTHON_INLINE_CHARS) {
        return {
          block: true,
          reason:
            "Local tool guard: blocked large inline python3 -c script (>= 800 chars). Put reusable analysis logic into a real workspace .py file (for example inspect_schema.py or analyze_dupes.py) using write(path, content) instead of giant inline python3 -c commands.",
        };
      }
      if (consecutivePythonProbes >= HARD_PYTHON_PROBE_STREAK) {
        return {
          block: true,
          reason:
            "Local tool guard: blocked excessive consecutive inline python3 -c probes. Stop exploratory probing and write your next workspace deliverable (.py script or notes.md) using write(path, content).",
        };
      }
    }

    if (isHardBlockedHeredocCommand(toolName, input)) {
      if (consecutiveSameCall >= 2) {
        return {
          block: true,
          reason:
            "Loop guard + heredoc guard: you already tried this blocked heredoc. Stop calling bash for this write. Call edit(path, oldText, newText) to update an existing file or write(path, content) for a new file.",
        };
      }
      return {
        block: true,
        reason:
          "Local tool guard: blocked large multi-line bash heredoc (>= 1000 chars). Use write(path, content) for new files or edit(path, oldText, newText) to update existing files.",
      };
    }

    if (consecutiveSameCall >= 3) {
      return {
        block: true,
        reason:
          "Loop guard: this exact tool call already ran twice with the same arguments. Do not repeat it again. Use the results you already have, move to the next deliverable, or update notes.md and call phase_handoff.",
      };
    }
  });

  pi.on("tool_result", (event, ctx) => {
    const toolName = String(event.toolName || "");
    if (toolName === "phase_handoff") {
      consecutivePythonProbes = 0;
      consecutiveShellReadProbes = 0;
      consecutiveAgentBrowserEvals = 0;
      return;
    }

    if (isPythonInlineProbe(toolName, event.input)) {
      consecutivePythonProbes += 1;
      consecutiveShellReadProbes = 0;
      consecutiveAgentBrowserEvals = 0;
    } else if (isShellReadProbe(toolName, event.input)) {
      consecutiveShellReadProbes += 1;
      consecutivePythonProbes = 0;
      consecutiveAgentBrowserEvals = 0;
    } else if (toolName === "write" || toolName === "edit" || toolName === "read" || toolName === "bash") {
      consecutivePythonProbes = 0;
      consecutiveShellReadProbes = 0;
      if (toolName !== "bash") {
        consecutiveAgentBrowserEvals = 0;
      }
    }

    const hints: string[] = [];
    if (isLargeHeredocCommand(toolName, event.input)) {
      hints.push(
        "[Local tool hint: Avoid multi-line bash heredocs. Put scripts in .py files using write or edit so you do not burn output tokens rewriting inline code.]",
      );
    }

    if (
      INLINE_PROBE_STREAK_WARN > 0 &&
      consecutivePythonProbes >= INLINE_PROBE_STREAK_WARN &&
      consecutivePythonProbes % INLINE_PROBE_STREAK_WARN === 0
    ) {
      hints.push(
        `[Local efficiency hint: ${consecutivePythonProbes} consecutive inline python3 -c probes. Batch remaining checks into 1 short script or move straight to writing/updating deliverables with write/edit.]`,
      );
    }

    if (
      INLINE_PROBE_STREAK_WARN > 0 &&
      consecutiveShellReadProbes >= INLINE_PROBE_STREAK_WARN &&
      consecutiveShellReadProbes % INLINE_PROBE_STREAK_WARN === 0
    ) {
      hints.push(
        `[Local efficiency hint: ${consecutiveShellReadProbes} consecutive bash cat/head/tail/sed reads. Prefer read(path, offset, limit) or edit(path, oldText, newText) instead of chaining shell reads.]`,
      );
    }

    if (consecutiveSameCall === 2) {
      hints.push(
        "[Loop guard: exact duplicate tool call (2nd time in a row). Do not run this same command again. Move to the next step or update notes.md and call phase_handoff.]",
      );
    }

    if (event.isError) {
      consecutiveErrors += 1;
      updateEscalationSignal("error");
      appendLocalTrace("local-context-guard", "tool_error", { tool: toolName, streak: consecutiveErrors });
      const sig = summarizeCallSignature(toolName, event.input);
      const repeatedExact = sig === lastErrorSignature;
      lastErrorSignature = sig;

      if (repeatedExact && consecutiveSameCall !== 2) {
        hints.push(
          "[Tool recovery hint: Exact duplicate failing call detected. Change approach instead of repeating the same command or arguments.]",
        );
      } else if (!repeatedExact && consecutiveErrors >= 2) {
        hints.push(
          `[Tool recovery hint: ${consecutiveErrors} consecutive tool failures. Pause, read the exact error line or file schema with a short command, and fix the root cause before retrying.]`,
        );
      }
    } else {
      consecutiveErrors = 0;
      lastErrorSignature = "";
    }

    const content = Array.isArray(event.content) ? event.content : [];
    const textBlocks: TextContent[] = [];
    const nonTextBlocks: ImageContent[] = [];
    for (const block of content) {
      if (block && block.type === "text") {
        textBlocks.push(block);
      } else if (block && block.type === "image") {
        nonTextBlocks.push(block);
      }
    }

    const fullText = textBlocks.map((block) => block.text).join("\n");
    const lineCount = fullText ? fullText.split(/\r?\n/).length : 0;

    const callId = String((event as { toolCallId?: string }).toolCallId || "last");
    const baseLintCount = baselineLintCounts.get(callId) ?? 0;
    baselineLintCounts.delete(callId);

    if (toolName === "write" || toolName === "edit") {
      const targetPath = String(event.input?.path ?? event.input?.file_path ?? "");
      if (event.isError && targetPath) {
        const prevStreak = (fileFailureStreak.get(targetPath) ?? 0) + 1;
        fileFailureStreak.set(targetPath, prevStreak);
        if (prevStreak >= 3 && isInsideGitRepo(ctx.cwd)) {
          appendLocalTrace("local-context-guard", "git_rollback_hint", { path: targetPath, streak: prevStreak });
          hints.push(
            `[Git recovery hint: ${prevStreak} consecutive edit/lint regressions on ${targetPath}. Inspect changes with bash('git diff -- ${targetPath}') or restore cleanly with bash('git checkout -- ${targetPath}') if the file drifted.]`,
          );
        }
      } else if (!event.isError) {
        const lintRes = lintFileIssues(targetPath, ctx.cwd);
        const newLintCount = Math.max(0, lintRes.lintErrors.length - baseLintCount);
        if (lintRes.syntaxError || newLintCount > 0) {
          updateEscalationSignal("error");
          const prevStreak = (fileFailureStreak.get(targetPath) ?? 0) + 1;
          fileFailureStreak.set(targetPath, prevStreak);
          appendLocalTrace("local-context-guard", "lint_delta", {
            path: targetPath,
            syntaxError: Boolean(lintRes.syntaxError),
            newLintCount,
            totalLintCount: lintRes.lintErrors.length,
          });
          const parts: string[] = [];
          if (lintRes.syntaxError) {
            parts.push(`Syntax error:\n${lintRes.syntaxError}`);
          }
          if (newLintCount > 0) {
            parts.push(
              `New semantic lint issues (${newLintCount} added, ${lintRes.lintErrors.length} total):\n${lintRes.lintErrors.slice(0, 8).join("\n")}`,
            );
          }
          hints.push(
            `[ACTION REQUIRED: Your ${toolName} on ${targetPath} introduced error(s):\n${parts.join("\n")}\nFix these immediately before running or moving on.]`,
          );
          if (prevStreak >= 3 && isInsideGitRepo(ctx.cwd)) {
            appendLocalTrace("local-context-guard", "git_rollback_hint", { path: targetPath, streak: prevStreak });
            hints.push(
              `[Git recovery hint: ${prevStreak} consecutive edit/lint regressions on ${targetPath}. Run bash('git checkout -- ${targetPath}') if you want to restart cleanly from the last commit.]`,
            );
          }
        } else {
          updateEscalationSignal("clean");
          if (targetPath) fileFailureStreak.delete(targetPath);
        }
      }
    } else if (!event.isError) {
      updateEscalationSignal("clean");
    }

    if (toolName === "bash") {
      const cmd = typeof event.input?.command === "string" ? event.input.command : "";
      const callKey = String((event as { toolCallId?: string }).toolCallId || "last");
      const startedAt = bashStartTimes.get(callKey);
      bashStartTimes.delete(callKey);
      if (startedAt !== undefined && SLOW_BASH_MS > 0) {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= SLOW_BASH_MS) {
          appendLocalTrace("local-context-guard", "bash_slow", { elapsedMs });
          hints.push(
            `[Runtime efficiency hint: That bash command took ${Math.round(elapsedMs / 1000)}s. Check for O(K^2) loops, unindexed joins, or mega-clusters on low-cardinality fields before re-running.]`,
          );
        }
      }

      const sessions = extractAgentBrowserSessions(cmd);
      for (const s of sessions.closed) {
        openBrowserSessions.delete(s);
      }
      if (!event.isError) {
        for (const s of sessions.opened) {
          openBrowserSessions.add(s);
        }
      }

      if (/\bagent-browser\s+eval\b/.test(cmd)) {
        consecutiveAgentBrowserEvals += 1;
        if (
          AGENT_BROWSER_EVAL_BATCH_NUDGE > 0 &&
          consecutiveAgentBrowserEvals >= AGENT_BROWSER_EVAL_BATCH_NUDGE &&
          consecutiveAgentBrowserEvals % AGENT_BROWSER_EVAL_BATCH_NUDGE === 0
        ) {
          hints.push(
            `[Browser efficiency hint: ${consecutiveAgentBrowserEvals} consecutive agent-browser eval calls. Batch all remaining DOM and interaction assertions into 1 compound IIFE returning compact JSON, then run agent-browser close.]`,
          );
        }
      } else {
        consecutiveAgentBrowserEvals = 0;
      }

      if (!event.isError || /\bagent-browser\b/.test(cmd)) {
        consecutiveVerifyScriptErrors = 0;
      } else if (VERIFY_SCRIPT_CMD_RE.test(cmd)) {
        consecutiveVerifyScriptErrors += 1;
        if (consecutiveVerifyScriptErrors >= 2) {
          hints.push(
            '[Browser verification nudge: Stop debugging fragile Node DOM/regex stubs. Open the built HTML directly in real headless Chromium using AGENT_BROWSER_SESSION="ui-$$" agent-browser open file:///ABS/PATH/review.html, run snapshot -i or eval, and close with agent-browser close.]',
          );
        }
      }
    }

    if (toolName === "edit" && event.isError && /Could not find (?:the exact text|edits\[\d+\])/i.test(fullText)) {
      const targetPath = String(event.input?.path ?? event.input?.file_path ?? "");
      const editsArr = Array.isArray(event.input?.edits) ? (event.input.edits as Record<string, unknown>[]) : null;
      const firstOldText = String(editsArr?.[0]?.oldText ?? event.input?.oldText ?? "");
      const lineHint = findClosestEditLineHint(targetPath, firstOldText, ctx.cwd);
      if (lineHint) {
        hints.push(lineHint);
      }
    }

    if (toolName === "bash" && event.isError && /\b(?:SyntaxError|IndentationError|TabError)\b/.test(fullText)) {
      hints.push(
        "[Syntax recovery hint: Inspect the exact failing line with read(path, offset, limit) and fix it with edit (or rewrite with write if <= 150 lines) before re-running.]",
      );
    }

    let maxChars = 0;
    let maxLines = 0;
    let headKeep = 35;
    let tailKeep = 45;
    const exemptDoc = isExemptInstructionTarget(toolName, event.input);

    if (exemptDoc) {
      maxChars = DEFAULT_MAX_EXEMPT_DOC_CHARS;
      maxLines = 0;
      headKeep = 160;
      tailKeep = 80;
    } else if (isExplicitLineSliceCommand(toolName, event.input)) {
      maxChars = DEFAULT_MAX_SED_CHARS;
      maxLines = DEFAULT_MAX_SED_LINES;
      headKeep = 110;
      tailKeep = 60;
    } else if (GUARDED_SHELL_TOOLS.has(toolName)) {
      maxChars = DEFAULT_MAX_TOOL_CHARS;
      maxLines = DEFAULT_MAX_TOOL_LINES;
      if (event.isError) {
        headKeep = 25;
        tailKeep = 65;
      }
    } else if (toolName === "read") {
      maxChars = DEFAULT_MAX_READ_CHARS;
      maxLines = DEFAULT_MAX_READ_LINES;
      headKeep = 120;
      tailKeep = 40;
    }

    const needsTrim =
      maxChars > 0 &&
      fullText.length > 0 &&
      (fullText.length > maxChars || (maxLines > 0 && lineCount > maxLines));

    if (!needsTrim && hints.length === 0) {
      return;
    }

    let nextText = fullText;
    if (needsTrim) {
      const targetBodyBudget = Math.max(1200, maxChars - 600);
      const trimmed = trimWithHeadAndTail(fullText, headKeep, tailKeep, targetBodyBudget);
      const spillPath = spillLogToDisk(
        ctx.cwd,
        toolName,
        String(event.toolCallId || "call"),
        fullText,
      );
      const whereNote = spillPath
        ? `Full output saved at ${spillPath}. Inspect slices with read(offset/limit) or python.`
        : "Re-run with head/tail/grep or smaller read(offset/limit) range.";
      nextText = `${trimmed.snippet}\n\n[Trimmed for local speed: kept head+tail from ${fullText.length} chars (${trimmed.totalLines} lines). ${whereNote}]`;
    }

    if (hints.length > 0) {
      nextText = nextText ? `${nextText}\n\n${hints.join("\n")}` : hints.join("\n");
    }

    const resultContent: (TextContent | ImageContent)[] = [
      { type: "text", text: nextText },
      ...nonTextBlocks,
    ];

    return {
      content: resultContent,
      ...(!needsTrim && event.structuredContent !== undefined
        ? { structuredContent: event.structuredContent }
        : {}),
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!lastAssistantSnapshot) return;
    if (fs.existsSync(path.join(ctx.cwd, ".pi-handoff.md"))) return;
    const reason = detectPrematureStop({
      ...lastAssistantSnapshot,
      hadToolCallsInSession,
    });
    if (!reason || consecutivePrematureRetries >= MAX_PREMATURE_RETRIES) return;

    consecutivePrematureRetries += 1;
    appendLocalTrace("local-context-guard", "premature_stop", { reason, retry: consecutivePrematureRetries });
    ctx.ui?.notify?.(
      `Auto-continuing after premature stop (${reason}, retry ${consecutivePrematureRetries}/${MAX_PREMATURE_RETRIES})...`,
      "info",
    );
    pi.sendUserMessage(
      "You stopped mid-task without calling a tool or finishing your response. Continue immediately: execute your next tool call, verify all deliverables, and write your final summary only when everything is complete.",
      { deliverAs: "followUp" },
    );
  });

  pi.on("session_shutdown", () => {
    for (const sess of openBrowserSessions) {
      try {
        execFileSync("agent-browser", ["close"], {
          env: { ...process.env, AGENT_BROWSER_SESSION: sess },
          timeout: 3000,
          stdio: "ignore",
        });
      } catch {
        // Ignore cleanup errors during shutdown.
      }
    }
    openBrowserSessions.clear();
  });
}
