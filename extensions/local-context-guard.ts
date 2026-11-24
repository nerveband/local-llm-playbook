import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
const INLINE_PROBE_STREAK_WARN = Number(process.env.PI_LOCAL_INLINE_PROBE_WARN || 3);

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

export default function localContextGuardExtension(pi: ExtensionAPI) {
  let consecutiveErrors = 0;
  let lastErrorSignature = "";
  let lastCallSignature = "";
  let consecutiveSameCall = 0;
  let consecutivePythonProbes = 0;
  let consecutiveShellReadProbes = 0;

  pi.on("session_start", () => {
    consecutiveErrors = 0;
    lastErrorSignature = "";
    lastCallSignature = "";
    consecutiveSameCall = 0;
    consecutivePythonProbes = 0;
    consecutiveShellReadProbes = 0;
  });

  pi.on("input", () => {
    consecutiveErrors = 0;
    lastErrorSignature = "";
    lastCallSignature = "";
    consecutiveSameCall = 0;
    consecutivePythonProbes = 0;
    consecutiveShellReadProbes = 0;
  });

  pi.on("tool_call", (event) => {
    const toolName = String(event.toolName || "");
    if (toolName === "phase_handoff") {
      return;
    }
    const input = event.input as Record<string, unknown> | undefined;
    const sig = summarizeCallSignature(toolName, input);
    if (sig === lastCallSignature) {
      consecutiveSameCall += 1;
    } else {
      lastCallSignature = sig;
      consecutiveSameCall = 1;
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
      return;
    }

    if (isPythonInlineProbe(toolName, event.input)) {
      consecutivePythonProbes += 1;
      consecutiveShellReadProbes = 0;
    } else if (isShellReadProbe(toolName, event.input)) {
      consecutiveShellReadProbes += 1;
      consecutivePythonProbes = 0;
    } else if (toolName === "write" || toolName === "edit" || toolName === "read" || toolName === "bash") {
      consecutivePythonProbes = 0;
      consecutiveShellReadProbes = 0;
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
}
