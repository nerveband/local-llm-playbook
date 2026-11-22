import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const HANDOFF_FILENAME = ".pi-handoff.md";
const HANDOFF_ARCHIVE_FILENAME = ".pi-handoff.last.md";
const HIGH_CONTEXT_RATIO = 0.72;
const MAX_AUTO_HANDOFFS = 3;

interface StagedHandoff {
  phaseCompleted: string;
  summary: string;
  nextTask: string;
  files: string[];
  autoContinue: boolean;
  filePath: string;
}

const PhaseHandoffParams = Type.Object({
  phase_completed: Type.String({
    minLength: 1,
    description: "Short name of the phase just completed, for example 'Phase 1: Schema and Dedupe Analysis'.",
  }),
  summary: Type.String({
    minLength: 1,
    description: "Concise factual summary of verified results, key counts, schema details, and decisions.",
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
});

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

export default function localPhaseHandoffExtension(pi: ExtensionAPI) {
  let pendingHandoff: StagedHandoff | null = null;
  let warnedHighContext = false;
  let autoHandoffCount = 0;

  pi.on("session_start", (event) => {
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
      warnedHighContext = false;
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
      "Set auto_continue to false when stopping for user review, or true only when the user requested automatic continuation into the next phase.",
      "Immediately after phase_handoff succeeds, stop calling tools and give a brief 2 to 4 line phase recap.",
    ],
    parameters: PhaseHandoffParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const files = Array.isArray(params.files)
        ? params.files.map((item) => item.trim()).filter((item) => item.length > 0)
        : [];
      const autoContinue = Boolean(params.auto_continue);
      const filePath = path.join(ctx.cwd, HANDOFF_FILENAME);

      const markdown = formatHandoffMarkdown({
        phaseCompleted: params.phase_completed,
        summary: params.summary,
        nextTask: params.next_task,
        files,
      });
      fs.writeFileSync(filePath, markdown, "utf-8");

      pendingHandoff = {
        phaseCompleted: params.phase_completed,
        summary: params.summary,
        nextTask: params.next_task,
        files,
        autoContinue,
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
    if (ratio < HIGH_CONTEXT_RATIO) {
      return;
    }

    warnedHighContext = true;
    const pct = Math.round(ratio * 100);
    return {
      content: [
        ...event.content,
        {
          type: "text",
          text: `\n[Context notice: ${pct}% of local context used. Save current facts to notes.md and call phase_handoff at the next clean milestone to move into a fresh session.]`,
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
      "Phase handoff saved to .pi-handoff.md. Review deliverables, then type /next-phase to start in a fresh session.",
      "info",
    );
  });

  pi.registerCommand("next-phase", {
    description: "Start the staged next phase from .pi-handoff.md in a fresh session",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const staged = pendingHandoff;
      const diskPath = staged?.filePath ?? path.join(ctx.cwd, HANDOFF_FILENAME);
      const userNotes = args.trim();

      let promptForNewSession = "";
      if (staged) {
        promptForNewSession = formatHandoffMarkdown(staged, userNotes);
      } else if (fs.existsSync(diskPath)) {
        const raw = fs.readFileSync(diskPath, "utf-8").trim();
        promptForNewSession = userNotes ? `${raw}\n\n## User Adjustments\n${userNotes}\n` : `${raw}\n`;
      } else {
        ctx.ui?.notify?.(`No staged handoff found at ${diskPath}.`, "error");
        return;
      }

      pendingHandoff = null;
      warnedHighContext = false;
      archiveHandoffFile(ctx.cwd);

      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const result = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (newCtx) => {
          if (newCtx.isIdle()) {
            await newCtx.sendUserMessage(promptForNewSession);
          } else {
            await newCtx.sendUserMessage(promptForNewSession, { deliverAs: "followUp" });
          }
          newCtx.ui?.notify?.("Started next phase in a fresh session.", "info");
        },
      });

      if (result.cancelled) {
        ctx.ui?.notify?.("Next-phase switch cancelled. Staged notes remain in .pi-handoff.last.md.", "info");
      }
    },
  });
}
