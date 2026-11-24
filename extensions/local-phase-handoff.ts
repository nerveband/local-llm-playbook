import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const HANDOFF_FILENAME = ".pi-handoff.md";
const HANDOFF_ARCHIVE_FILENAME = ".pi-handoff.last.md";
const HIGH_CONTEXT_TOKENS = Number(process.env.PI_LOCAL_HANDOFF_TOKENS || 32000);
const HIGH_CONTEXT_RATIO = 0.72;
const MAX_AUTO_HANDOFFS = 3;

type LocalThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const VALID_THINKING_LEVELS = new Set<LocalThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

interface StagedHandoff {
  phaseCompleted: string;
  summary: string;
  nextTask: string;
  files: string[];
  autoContinue: boolean;
  nextThinkingLevel?: LocalThinkingLevel;
  filePath: string;
}

const PhaseHandoffParams = Type.Object({
  phase_completed: Type.String({
    minLength: 1,
    description: "Short name of the phase just completed, for example 'Phase 1: Schema and Dedupe Analysis'.",
  }),
  summary: Type.String({
    minLength: 1,
    description:
      "Concise factual summary including exact verified CSV column names, JSON schema keys, row counts, key decisions, and file paths so the next phase does not re-inspect input files.",
  }),
  next_task: Type.String({
    minLength: 1,
    description: "Clear self-contained task prompt for the next phase session.",
  }),
  files: Type.Optional(
    Type.Array(Type.String(), {
      description: "Important file paths on disk (for example notes.md, scripts, JSON deliverables).",
    }),
  ),
  auto_continue: Type.Optional(
    Type.Boolean({
      description: "True only if the user asked for hands-free automatic Phase 2 launch. Default false pauses for review.",
    }),
  ),
  next_thinking_level: Type.Optional(
    Type.Union(
      [
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ],
      {
        description:
          "Recommended thinking level for the next phase session. Use 'low' for clear implementation/UI/CSV/script building when schemas and rules are settled, 'medium' for analysis or debugging, and 'high' only for hard algorithmic or architectural problems. Omit to keep the current level.",
      },
    ),
  ),
});

function normalizeThinkingLevel(value: unknown): LocalThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase() as LocalThinkingLevel;
  return VALID_THINKING_LEVELS.has(candidate) ? candidate : undefined;
}

function parseRecommendedThinkingFromMarkdown(markdown: string): LocalThinkingLevel | undefined {
  const match = markdown.match(/^## Recommended Thinking Level\s*\n\s*(off|minimal|low|medium|high|xhigh|max)\b/im);
  return match ? normalizeThinkingLevel(match[1]) : undefined;
}

function parseNextPhaseArgs(args: string): { thinkOverride?: LocalThinkingLevel; userNotes: string } {
  const trimmed = args.trim();
  const match = trimmed.match(/^--think(?:=|\s+)(off|minimal|low|medium|high|xhigh|max)\b(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return { userNotes: trimmed };
  }
  return {
    thinkOverride: normalizeThinkingLevel(match[1]),
    userNotes: (match[2] ?? "").trim(),
  };
}

function formatHandoffMarkdown(data: Omit<StagedHandoff, "autoContinue" | "filePath">, userNotes?: string): string {
  const filesSection =
    data.files.length > 0
      ? data.files.map((item) => `- \`${item}\``).join("\n")
      : "- Read `notes.md` in the working directory for created artifacts.";

  const lines = [
    "# Phase Handoff",
    "",
    "## Completed Phase",
    data.phaseCompleted.trim(),
    "",
    "## Verified Context and Decisions",
    data.summary.trim(),
    "",
    "## Key Files on Disk",
    filesSection,
    "",
    "## Next Phase Task",
    data.nextTask.trim(),
  ];

  if (data.nextThinkingLevel) {
    lines.push("", "## Recommended Thinking Level", data.nextThinkingLevel);
  }

  const extra = userNotes?.trim();
  if (extra) {
    lines.push("", "## User Adjustments", extra);
  }

  return `${lines.join("\n")}\n`;
}

function archiveHandoffFile(cwd: string): void {
  const src = path.join(cwd, HANDOFF_FILENAME);
  const dst = path.join(cwd, HANDOFF_ARCHIVE_FILENAME);
  if (!fs.existsSync(src)) {
    return;
  }
  try {
    fs.renameSync(src, dst);
  } catch {
    // Keep going even if rename fails
  }
}

function nextThinkSignalPath(cwd: string): string {
  const hash = crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `pi-local-next-think-${hash}.txt`);
}

function writeNextThinkSignal(cwd: string, level: LocalThinkingLevel): void {
  try {
    fs.writeFileSync(nextThinkSignalPath(cwd), level, "utf-8");
  } catch {
    // Ignore temp write errors
  }
}

function consumeNextThinkSignal(cwd: string): LocalThinkingLevel | undefined {
  const signalPath = nextThinkSignalPath(cwd);
  if (!fs.existsSync(signalPath)) return undefined;
  try {
    const raw = fs.readFileSync(signalPath, "utf-8");
    fs.unlinkSync(signalPath);
    return normalizeThinkingLevel(raw);
  } catch {
    return undefined;
  }
}

export default function localPhaseHandoffExtension(pi: ExtensionAPI) {
  let pendingHandoff: StagedHandoff | null = null;
  let warnedHighContext = false;
  let autoHandoffCount = 0;

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
      warnedHighContext = false;
    }
    if (event.reason === "new") {
      const pendingLevel = consumeNextThinkSignal(ctx.cwd);
      if (pendingLevel) {
        pi.setThinkingLevel(pendingLevel as any);
      }
    }
  });

  pi.on("input", (event) => {
    if (event.source === "interactive" && !event.text.trim().startsWith("/next-phase")) {
      autoHandoffCount = 0;
    }
  });

  pi.registerTool({
    name: "phase_handoff",
    label: "Phase Handoff",
    description:
      "Save verified progress to .pi-handoff.md and stage a clean fresh session for the next phase. Always update notes.md first, then call this once and stop calling tools.",
    promptSnippet:
      "Save a phase boundary summary to .pi-handoff.md so the user or Pi can switch to a clean next-phase session.",
    promptGuidelines: [
      "Before calling phase_handoff, ensure notes.md and deliverable files are written and verified on disk.",
      "Only call phase_handoff when another phase remains for Pi to run later. If the entire task is done and only human review remains, update notes.md and summarize directly without staging a handoff.",
      "Set auto_continue to false when stopping for user review, or true only when the user requested automatic continuation into the next phase.",
      "Immediately after phase_handoff succeeds, stop calling tools and give a brief 2 to 4 line phase recap.",
    ],
    parameters: PhaseHandoffParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const files = Array.isArray(params.files)
        ? params.files.map((item) => item.trim()).filter((item) => item.length > 0)
        : [];
      const autoContinue = Boolean(params.auto_continue);
      const nextThinkingLevel = normalizeThinkingLevel(params.next_thinking_level);
      const filePath = path.join(ctx.cwd, HANDOFF_FILENAME);

      const markdown = formatHandoffMarkdown({
        phaseCompleted: params.phase_completed,
        summary: params.summary,
        nextTask: params.next_task,
        files,
        nextThinkingLevel,
      });
      fs.writeFileSync(filePath, markdown, "utf-8");

      pendingHandoff = {
        phaseCompleted: params.phase_completed,
        summary: params.summary,
        nextTask: params.next_task,
        files,
        autoContinue,
        nextThinkingLevel,
        filePath,
      };

      const actionHint = autoContinue
        ? "Auto-continue is enabled: stop calling tools now and write a short closing recap so the next session can launch."
        : "Pause-for-review mode: stop calling tools now, summarize what is on disk in 2 to 4 lines, and tell the user to run /next-phase when ready.";

      return {
        content: [
          {
            type: "text",
            text: `Staged phase handoff at ${filePath}. ${actionHint}`,
          },
        ],
        details: {
          filePath,
          autoContinue,
          nextThinkingLevel,
          phaseCompleted: params.phase_completed,
        },
      };
    },
  });

  pi.on("tool_result", (event, ctx) => {
    if (warnedHighContext || event.toolName === "phase_handoff") {
      return;
    }

    const usage = ctx.getContextUsage();
    if (!usage || typeof usage.tokens !== "number" || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) {
      return;
    }

    const ratio = usage.tokens / usage.contextWindow;
    const hitTokenLimit = HIGH_CONTEXT_TOKENS > 0 && usage.tokens >= HIGH_CONTEXT_TOKENS;
    if (!hitTokenLimit && ratio < HIGH_CONTEXT_RATIO) {
      return;
    }

    warnedHighContext = true;
    const pct = Math.round(ratio * 100);
    return {
      content: [
        ...event.content,
        {
          type: "text",
          text: `\n[Local speed notice: ${usage.tokens.toLocaleString()} tokens used (${pct}% of window). Local decode slows above 32K tokens. Update notes.md and call phase_handoff at the next clean milestone if more work remains.]`,
        },
      ],
      ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!pendingHandoff) {
      return;
    }

    if (pendingHandoff.autoContinue) {
      if (autoHandoffCount >= MAX_AUTO_HANDOFFS) {
        pendingHandoff.autoContinue = false;
        ctx.ui?.notify?.(
          `Auto-handoff paused after ${MAX_AUTO_HANDOFFS} automatic phase transitions. Review .pi-handoff.md and run /next-phase manually.`,
          "warning",
        );
        return;
      }

      autoHandoffCount += 1;
      ctx.ui?.notify?.(
        `Phase handoff staged (${autoHandoffCount}/${MAX_AUTO_HANDOFFS}). Launching next phase in a fresh session...`,
        "info",
      );
      pi.sendUserMessage("/next-phase", { expandPromptTemplates: true });
      return;
    }

    ctx.ui?.notify?.(
      "Phase handoff saved to .pi-handoff.md (paused for review). Review outputs on disk, then run /next-phase when you want Pi to continue.",
      "info",
    );
  });

  pi.registerCommand("next-phase", {
    description: "Start the staged next phase from .pi-handoff.md in a fresh session (supports --think <level>)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const staged = pendingHandoff;
      const diskPath = staged?.filePath ?? path.join(ctx.cwd, HANDOFF_FILENAME);
      const { thinkOverride, userNotes } = parseNextPhaseArgs(args);

      let promptForNewSession = "";
      let diskThinkingLevel: LocalThinkingLevel | undefined;
      if (staged) {
        promptForNewSession = formatHandoffMarkdown(staged, userNotes);
      } else if (fs.existsSync(diskPath)) {
        const raw = fs.readFileSync(diskPath, "utf-8").trim();
        diskThinkingLevel = parseRecommendedThinkingFromMarkdown(raw);
        promptForNewSession = userNotes ? `${raw}\n\n## User Adjustments\n${userNotes}\n` : `${raw}\n`;
      } else {
        ctx.ui?.notify?.(`No staged handoff found at ${diskPath}.`, "error");
        return;
      }

      const targetThinkingLevel = thinkOverride ?? staged?.nextThinkingLevel ?? diskThinkingLevel;
      pendingHandoff = null;
      warnedHighContext = false;
      archiveHandoffFile(ctx.cwd);
      if (targetThinkingLevel) {
        writeNextThinkSignal(ctx.cwd, targetThinkingLevel);
      }

      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const result = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (newCtx) => {
          newCtx.ui?.notify?.(
            targetThinkingLevel
              ? `Started next phase in a fresh session (thinking: ${targetThinkingLevel}).`
              : "Started next phase in a fresh session.",
            "info",
          );
          if (newCtx.isIdle()) {
            await newCtx.sendUserMessage(promptForNewSession);
          } else {
            await newCtx.sendUserMessage(promptForNewSession, { deliverAs: "followUp" });
          }
        },
      });

      if (result.cancelled) {
        consumeNextThinkSignal(ctx.cwd);
        ctx.ui?.notify?.("Next-phase switch cancelled. Staged notes remain in .pi-handoff.last.md.", "info");
      }
    },
  });
}
