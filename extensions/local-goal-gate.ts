import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendLocalTrace } from "./local-trace.ts";

export interface VerifySpec {
  requiredFiles?: string[];
  jsonFiles?: string[];
  htmlFiles?: string[];
  shellChecks?: string[];
  maxRetries?: number;
}

export interface GoalState {
  status: "inactive" | "active" | "complete" | "paused";
  objective: string;
  continuationCount: number;
  maxContinuations: number;
  lastFailures: string[];
}

const DEFAULT_MAX_RETRIES = Number(process.env.PI_LOCAL_GOAL_MAX_RETRIES || 3);
const VERIFY_SPEC_FILE = ".pi-verify.json";

function resolveSafePath(cwd: string, rel: string): string {
  return path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
}

/** Validate a .pi-verify.json spec deterministically in under a few seconds. */
export function evaluateVerifySpec(cwd: string, spec: VerifySpec): string[] {
  const failures: string[] = [];

  for (const rel of spec.requiredFiles ?? []) {
    const abs = resolveSafePath(cwd, rel);
    if (!fs.existsSync(abs)) {
      failures.push(`Missing required file: ${rel}`);
      continue;
    }
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size === 0) {
        failures.push(`Required file is empty (0 bytes): ${rel}`);
      }
    } catch {
      failures.push(`Unreadable required file: ${rel}`);
    }
  }

  for (const rel of spec.jsonFiles ?? []) {
    const abs = resolveSafePath(cwd, rel);
    if (!fs.existsSync(abs)) {
      failures.push(`Missing JSON file: ${rel}`);
      continue;
    }
    try {
      const raw = fs.readFileSync(abs, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed === null || (Array.isArray(parsed) && parsed.length === 0)) {
        failures.push(`JSON file parsed as null or empty array: ${rel}`);
      }
    } catch (err: any) {
      failures.push(`Invalid JSON in ${rel}: ${String(err?.message || err).slice(0, 120)}`);
    }
  }

  for (const rel of spec.htmlFiles ?? []) {
    const abs = resolveSafePath(cwd, rel);
    if (!fs.existsSync(abs)) {
      failures.push(`Missing HTML deliverable: ${rel}`);
      continue;
    }
    try {
      const verifyBin = fs.existsSync("/Users/nerveband/.local/bin/pi-verify-ui")
        ? "/Users/nerveband/.local/bin/pi-verify-ui"
        : "pi-verify-ui";
      execFileSync(verifyBin, [abs], {
        cwd,
        timeout: 20000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      const out = String(err?.stdout || err?.stderr || err?.message || "UI check failed").trim();
      failures.push(`Browser UI verification failed for ${rel}: ${out.slice(0, 220)}`);
    }
  }

  for (const cmd of spec.shellChecks ?? []) {
    try {
      execFileSync("/bin/zsh", ["-lc", cmd], {
        cwd,
        timeout: 15000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      const out = String(err?.stderr || err?.stdout || err?.message || "check failed").trim();
      failures.push(`Shell check failed (${cmd}): ${out.slice(0, 180)}`);
    }
  }

  return failures;
}

export function loadVerifySpec(cwd: string): VerifySpec | null {
  const specPath = path.join(cwd, VERIFY_SPEC_FILE);
  if (!fs.existsSync(specPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as VerifySpec) : null;
  } catch {
    return null;
  }
}

const UpdateGoalParams = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["complete", "blocked"],
      description:
        "Call with 'complete' only after all requirements and checks pass on disk, or 'blocked' with exact reason.",
    },
    evidence: {
      type: "string",
      minLength: 1,
      description: "Short factual summary of verified files and checks.",
    },
  },
  required: ["status", "evidence"],
} as any;

export default function localGoalGateExtension(pi: ExtensionAPI) {
  let state: GoalState = {
    status: "inactive",
    objective: "",
    continuationCount: 0,
    maxContinuations: Math.max(1, DEFAULT_MAX_RETRIES),
    lastFailures: [],
  };

  function updateUiPill(ctx: ExtensionContext | undefined): void {
    if (!ctx?.ui?.setStatus) return;
    if (state.status === "active") {
      ctx.ui.setStatus("local-goal-gate", `🎯 goal (${state.continuationCount}/${state.maxContinuations})`);
    } else if (state.status === "complete") {
      ctx.ui.setStatus("local-goal-gate", "🎯 complete");
    } else if (state.status === "paused") {
      ctx.ui.setStatus("local-goal-gate", "🎯 paused");
    } else {
      ctx.ui.setStatus("local-goal-gate", undefined);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    state.status = "inactive";
    state.objective = "";
    state.continuationCount = 0;
    state.lastFailures = [];
    updateUiPill(ctx);
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "interactive" && !event.text.trim().startsWith("/goal")) {
      state.continuationCount = 0;
      state.lastFailures = [];
      updateUiPill(ctx);
    }
  });

  pi.on("before_provider_request", (event) => {
    if (state.status !== "active" || !state.objective) return;
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || !Array.isArray(payload.messages)) return;
    const msgs = payload.messages as { role?: string; content?: unknown }[];
    // Keep prefix cache intact when possible; append objective anchor only to the final user turn if not already present.
    const lastUserIdx = [...msgs].reverse().findIndex((m) => m?.role === "user");
    if (lastUserIdx === -1) return;
    const realIdx = msgs.length - 1 - lastUserIdx;
    const target = msgs[realIdx];
    if (typeof target.content === "string" && !target.content.includes("[Active Goal Anchor]")) {
      const nextMsgs = msgs.slice();
      nextMsgs[realIdx] = {
        ...target,
        content: `${target.content}\n\n[Active Goal Anchor]: ${state.objective}`,
      };
      return { ...payload, messages: nextMsgs };
    }
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Mark the active /goal objective complete after deterministic verification passes, or report a concrete blocker.",
    parameters: UpdateGoalParams,
    async execute(_id, params, _sig, _onUpd, ctx) {
      if (params.status === "blocked") {
        state.status = "paused";
        updateUiPill(ctx);
        appendLocalTrace("local-goal-gate", "goal_blocked", { evidence: params.evidence });
        return { content: [{ type: "text", text: `Goal paused as blocked: ${params.evidence}` }] };
      }

      const spec = loadVerifySpec(ctx.cwd);
      const failures = spec ? evaluateVerifySpec(ctx.cwd, spec) : [];
      if (failures.length > 0) {
        appendLocalTrace("local-goal-gate", "goal_reject", { failures });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Cannot mark goal complete yet. Remaining failures:\n- ${failures.join("\n- ")}`,
            },
          ],
        };
      }

      state.status = "complete";
      updateUiPill(ctx);
      appendLocalTrace("local-goal-gate", "goal_complete", { evidence: params.evidence });
      return { content: [{ type: "text", text: `Goal marked complete. Verified: ${params.evidence}` }] };
    },
  });

  pi.registerCommand("goal", {
    description: "Set, view, pause, or clear an autonomous session goal: /goal <objective> | /goal clear",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        const msg = state.status === "inactive"
          ? "No active goal. Usage: /goal <objective>"
          : `Goal (${state.status}, retries ${state.continuationCount}/${state.maxContinuations}): ${state.objective}`;
        ctx.ui?.notify?.(msg, "info");
        return;
      }
      if (text === "clear" || text === "off" || text === "pause") {
        state.status = text === "pause" ? "paused" : "inactive";
        updateUiPill(ctx);
        ctx.ui?.notify?.(`Goal ${state.status}.`, "info");
        return;
      }
      state = {
        status: "active",
        objective: text,
        continuationCount: 0,
        maxContinuations: Math.max(1, DEFAULT_MAX_RETRIES),
        lastFailures: [],
      };
      updateUiPill(ctx);
      const prompt = `Active session goal started:\n${text}\n\nWork systematically until every deliverable and verification check passes on disk, then call update_goal(status="complete", evidence=...).`;
      if (ctx.isIdle()) {
        await ctx.sendUserMessage(prompt);
      } else {
        await ctx.sendUserMessage(prompt, { deliverAs: "followUp" });
      }
    },
  });

  pi.on("agent_end", (_event, ctx) => {
    if (fs.existsSync(path.join(ctx.cwd, ".pi-handoff.md"))) return;

    const spec = loadVerifySpec(ctx.cwd);
    const hasSpec = spec !== null;
    const goalActive = state.status === "active";
    if (!hasSpec && !goalActive) return;

    const maxRetries = Math.max(1, spec?.maxRetries ?? state.maxContinuations);
    const failures = spec ? evaluateVerifySpec(ctx.cwd, spec) : [];
    state.lastFailures = failures;

    if (hasSpec && failures.length === 0) {
      if (goalActive) {
        state.status = "complete";
        updateUiPill(ctx);
      }
      appendLocalTrace("local-goal-gate", "goal_gate_pass", { retriesUsed: state.continuationCount });
      return;
    }

    if (state.continuationCount >= maxRetries) {
      if (goalActive) {
        state.status = "paused";
        updateUiPill(ctx);
      }
      appendLocalTrace("local-goal-gate", "goal_gate_exhausted", { failures });
      ctx.ui?.notify?.(
        `Goal gate stopped after ${maxRetries} continuations. Remaining issues: ${failures.join("; ") || "update_goal not called"}`,
        "warning",
      );
      return;
    }

    state.continuationCount += 1;
    updateUiPill(ctx);
    appendLocalTrace("local-goal-gate", "goal_gate_retry", {
      attempt: state.continuationCount,
      maxRetries,
      failures,
    });

    const failureBlock =
      failures.length > 0
        ? `Deterministic checks found unresolved items:\n- ${failures.join("\n- ")}`
        : `Goal is still active ("${state.objective}"). Verify every requirement against files on disk and call update_goal(status="complete", evidence=...) when done.`;

    ctx.ui?.notify?.(
      `Goal gate auto-continuing (${state.continuationCount}/${maxRetries})...`,
      "info",
    );
    pi.sendUserMessage(
      `${failureBlock}\n\nFix these items now, re-run verification, and finish only when every check passes.`,
      { deliverAs: "followUp" },
    );
  });
}
