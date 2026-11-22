import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_TOOL_CHARS = Number(process.env.PI_LOCAL_MAX_TOOL_CHARS || 6000);
const DEFAULT_MAX_TOOL_LINES = Number(process.env.PI_LOCAL_MAX_TOOL_LINES || 120);
const DEFAULT_MAX_READ_CHARS = Number(process.env.PI_LOCAL_MAX_READ_CHARS || 14000);
const DEFAULT_MAX_READ_LINES = Number(process.env.PI_LOCAL_MAX_READ_LINES || 260);

const GUARDED_SHELL_TOOLS = new Set(["bash", "powershell", "grep", "find", "ls"]);

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
    return `${toolName}:${JSON.stringify(input).slice(0, 220)}`;
  } catch {
    return toolName;
  }
}

function isLargeHeredocCommand(toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (toolName !== "bash" || !input) return false;
  const cmd = typeof input.command === "string" ? input.command : "";
  if (cmd.length < 400) return false;
  return /<<['"]?[A-Za-z0-9_]+['"]?/.test(cmd);
}

export default function localContextGuardExtension(pi: ExtensionAPI) {
  let consecutiveErrors = 0;
  let lastErrorSignature = "";

  pi.on("session_start", () => {
    consecutiveErrors = 0;
    lastErrorSignature = "";
  });

  pi.on("input", () => {
    consecutiveErrors = 0;
    lastErrorSignature = "";
  });

  pi.on("tool_result", (event, ctx) => {
    const toolName = String(event.toolName || "");
    if (toolName === "phase_handoff") {
      return;
    }

    const hints: string[] = [];
    if (event.isError) {
      consecutiveErrors += 1;
      const sig = summarizeCallSignature(toolName, event.input);
      const repeatedExact = sig === lastErrorSignature;
      lastErrorSignature = sig;

      if (isLargeHeredocCommand(toolName, event.input)) {
        hints.push(
          "[Local tool hint: Avoid multi-line bash heredocs for editing or writing code. Use the edit or write tool directly so changes stay verifiable.]",
        );
      }

      if (repeatedExact) {
        hints.push(
          "[Tool recovery hint: Exact duplicate failing call detected. Change approach instead of repeating the same command or arguments.]",
        );
      } else if (consecutiveErrors >= 2) {
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

    if (GUARDED_SHELL_TOOLS.has(toolName)) {
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
      (fullText.length > maxChars || lineCount > maxLines);

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
