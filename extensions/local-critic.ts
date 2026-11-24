import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendLocalTrace } from "./local-trace.ts";

const MAX_CODE_CHARS = 14000;
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "DataExport-2026-11-21"]);
const CODE_EXTS = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".html", ".css"]);

function resolveCriticEndpoint(ctx: ExtensionContext): { url: string; model: string; apiKey: string; provider: string } | null {
  const modelObj = ctx.model as { id?: string; provider?: string; baseUrl?: string; apiKey?: string } | undefined;
  const provider = String(modelObj?.provider || "").toLowerCase();
  const id = String(modelObj?.id || "");
  let baseUrl = String(modelObj?.baseUrl || "");
  if (!baseUrl) {
    if (provider === "inkling-local") baseUrl = "http://127.0.0.1:18089/v1";
    else if (provider === "surogate-local") baseUrl = "http://127.0.0.1:18091/v1";
    else if (provider === "ornith-splash") baseUrl = "http://127.0.0.1:18092/v1";
    else if (provider === "omlx-local" || provider === "omlx") baseUrl = "http://127.0.0.1:8000/v1";
  }
  if (!baseUrl || !id) return null;
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    model: id,
    apiKey: String(modelObj?.apiKey || "local-placeholder"),
    provider,
  };
}

/** Collect compact workspace file list + code snippets + git diff with zero CSV data rows. */
export function collectCriticBundle(cwd: string): string {
  const sections: string[] = [];
  const files: string[] = [];
  const codeSnippets: string[] = [];
  let charBudget = MAX_CODE_CHARS;

  function walk(dir: string, depth: number): void {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".") || SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(cwd, full);
      if (ent.isDirectory()) {
        files.push(`${rel}/`);
        walk(full, depth + 1);
      } else {
        files.push(rel);
        const ext = path.extname(ent.name).toLowerCase();
        if (CODE_EXTS.has(ext) && charBudget > 500) {
          try {
            const st = fs.statSync(full);
            if (st.size <= 64000) {
              const raw = fs.readFileSync(full, "utf-8");
              const slice = raw.slice(0, Math.min(3500, charBudget));
              codeSnippets.push(`### ${rel}\n\`\`\`\n${slice}\n\`\`\``);
              charBudget -= slice.length;
            }
          } catch {
            // Skip unreadable file.
          }
        }
      }
    }
  }

  walk(cwd, 0);
  sections.push(`Files on disk:\n${files.slice(0, 60).map((f) => `- ${f}`).join("\n")}`);

  try {
    const diff = execFileSync("git", ["diff", "--unified=2"], {
      cwd,
      timeout: 3000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (diff) {
      sections.push(`Git diff excerpt:\n\`\`\`diff\n${diff.slice(0, 5000)}\n\`\`\``);
    }
  } catch {
    // Workspace might not be a git repository.
  }

  if (codeSnippets.length > 0) {
    sections.push(codeSnippets.join("\n\n"));
  }

  return sections.join("\n\n");
}

export function parseCriticVerdict(rawText: string): { pass: boolean; defects: string[] } {
  const cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as { pass?: boolean; defects?: unknown[] };
      const defects = Array.isArray(obj.defects)
        ? obj.defects.map((d) => String(d).trim()).filter((d) => d.length > 0)
        : [];
      if (obj.pass === true && defects.length === 0) return { pass: true, defects: [] };
      if (defects.length > 0) return { pass: false, defects };
    } catch {
      // Fallback to text parsing.
    }
  }
  if (/^\s*PASS\b/i.test(cleaned)) return { pass: true, defects: [] };
  const bullets = cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim())
    .filter((l) => l.length > 8 && !/^\{|\}$/.test(l));
  return bullets.length > 0 ? { pass: false, defects: bullets.slice(0, 6) } : { pass: true, defects: [] };
}

async function runFreshCritic(ctx: ExtensionContext, focus: string): Promise<{ pass: boolean; defects: string[] } | null> {
  const ep = resolveCriticEndpoint(ctx);
  if (!ep) return null;

  const bundle = collectCriticBundle(ctx.cwd);
  const prompt = [
    "You are an independent, strict code reviewer in a clean context.",
    focus ? `Review focus: ${focus}` : "Inspect for concrete bugs, missing deliverables, bad DOM selectors, O(K^2) performance risks, or unhandled errors.",
    "Do NOT invent minor style complaints. Respond ONLY with JSON: {\"pass\": true, \"defects\": []} if solid, or {\"pass\": false, \"defects\": [\"...\"]} with up to 5 concrete defects.",
    "",
    bundle,
  ].join("\n");

  const body: Record<string, unknown> = {
    model: ep.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    top_p: 0.95,
    max_tokens: 1400,
    stream: false,
  };
  if (ep.provider === "inkling-local") {
    body.reasoning_effort = "low";
  } else if (ep.provider === "surogate-local" || ep.provider === "ornith-splash") {
    body.chat_template_kwargs = { enable_thinking: true, preserve_thinking: false };
    body.thinking_token_budget = 1024;
    body.top_k = 20;
  }

  try {
    const resp = await fetch(ep.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const content = String(data?.choices?.[0]?.message?.content || "");
    if (!content.trim()) return null;
    return parseCriticVerdict(content);
  } catch {
    return null;
  }
}

export default function localCriticExtension(pi: ExtensionAPI) {
  let criticRanThisTask = false;
  let lastUserPrompt = "";

  pi.on("session_start", () => {
    criticRanThisTask = false;
    lastUserPrompt = "";
  });

  pi.on("input", (event) => {
    if (event.source === "interactive" && !event.text.trim().startsWith("/critic")) {
      criticRanThisTask = false;
      lastUserPrompt = event.text.slice(0, 600);
    }
  });

  pi.registerCommand("critic", {
    description: "Run a zero-swap fresh-context adversarial review on current workspace deliverables",
    handler: async (args, ctx) => {
      ctx.ui?.notify?.("Running fresh-context adversarial critic pass...", "info");
      const verdict = await runFreshCritic(ctx, args.trim() || lastUserPrompt);
      if (!verdict) {
        ctx.ui?.notify?.("Critic pass could not reach active local server.", "warning");
        return;
      }
      appendLocalTrace("local-critic", "manual_critic", { pass: verdict.pass, defects: verdict.defects });
      if (verdict.pass) {
        ctx.ui?.notify?.("Critic verdict: PASS (no concrete defects found).", "info");
        return;
      }
      const msg = `Independent critic review found ${verdict.defects.length} concrete issue(s):\n- ${verdict.defects.join("\n- ")}\n\nFix these issues and re-verify.`;
      if (ctx.isIdle()) {
        await ctx.sendUserMessage(msg);
      } else {
        await ctx.sendUserMessage(msg, { deliverAs: "followUp" });
      }
    },
  });

  pi.on("agent_end", (_event, ctx) => {
    if (process.env.PI_LOCAL_AUTO_CRITIC !== "1") return;
    if (criticRanThisTask) return;
    if (fs.existsSync(path.join(ctx.cwd, ".pi-handoff.md"))) return;

    criticRanThisTask = true;
    void runFreshCritic(ctx, lastUserPrompt).then((verdict) => {
      if (!verdict) return;
      appendLocalTrace("local-critic", "auto_critic", { pass: verdict.pass, defects: verdict.defects });
      if (!verdict.pass && verdict.defects.length > 0) {
        const g = globalThis as typeof globalThis & { __piLocalEscalation?: { offset: number; criticPending?: boolean } };
        if (g.__piLocalEscalation) {
          g.__piLocalEscalation.offset = Math.max(g.__piLocalEscalation.offset, 1);
          g.__piLocalEscalation.criticPending = true;
        }
        ctx.ui?.notify?.(
          `Auto-critic flagged ${verdict.defects.length} issue(s); sending repair pass...`,
          "info",
        );
        pi.sendUserMessage(
          `Independent fresh-context critic review flagged ${verdict.defects.length} defect(s):\n- ${verdict.defects.join("\n- ")}\n\nFix these specific issues and run a final verification check.`,
          { deliverAs: "followUp" },
        );
      }
    });
  });
}
