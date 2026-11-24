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

/** Collect PII-free workspace inventory + balanced code excerpts + git diff with zero CSV data rows. */
export function collectCriticBundle(cwd: string): string {
  const sections: string[] = [];
  const inventory: string[] = [];
  const codeCandidates: { rel: string; raw: string }[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".") || SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(cwd, full);
      if (ent.isDirectory()) {
        inventory.push(`- ${rel}/`);
        walk(full, depth + 1);
      } else {
        let sizeBytes = 0;
        try {
          sizeBytes = fs.statSync(full).size;
        } catch {
          // Keep 0 byte fallback if stat fails.
        }
        inventory.push(`- ${rel} (${sizeBytes} bytes)`);
        const ext = path.extname(ent.name).toLowerCase();
        if (CODE_EXTS.has(ext) && sizeBytes > 0 && sizeBytes <= 64000) {
          try {
            codeCandidates.push({ rel, raw: fs.readFileSync(full, "utf-8") });
          } catch {
            // Skip unreadable file.
          }
        }
      }
    }
  }

  walk(cwd, 0);
  sections.push(`Workspace inventory (authoritative list of files on disk):\n${inventory.slice(0, 80).join("\n")}`);

  try {
    const promptPath = path.join(cwd, "PROMPT.md");
    if (fs.existsSync(promptPath)) {
      const pRaw = fs.readFileSync(promptPath, "utf-8").slice(0, 1500);
      sections.push(`Task requirements excerpt (PROMPT.md):\n\`\`\`\n${pRaw}\n\`\`\``);
    }
  } catch {
    // Ignore unreadable PROMPT.md.
  }

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

  if (codeCandidates.length > 0) {
    const codeSnippets: string[] = [];
    const perFileBudget = Math.max(1200, Math.floor(MAX_CODE_CHARS / codeCandidates.length));
    let charBudget = MAX_CODE_CHARS;
    for (const item of codeCandidates) {
      if (charBudget < 400) break;
      const cap = Math.min(perFileBudget, charBudget);
      let slice: string;
      if (item.raw.length <= cap) {
        slice = item.raw;
      } else {
        const half = Math.max(400, Math.floor((cap - 60) / 2));
        slice = `${item.raw.slice(0, half)}\n[... excerpt trimmed to fit critic budget ...]\n${item.raw.slice(-half)}`;
      }
      codeSnippets.push(`### ${item.rel}\n\`\`\`\n${slice}\n\`\`\``);
      charBudget -= slice.length;
    }
    if (codeSnippets.length > 0) {
      sections.push(codeSnippets.join("\n\n"));
    }
  }

  return sections.join("\n\n");
}

export function isFalsePositiveInlineDataDefect(defect: string): boolean {
  const s = String(defect || "");
  return (
    /(embed|embeds|embedded|inline|inlined|single[- ]file|payload|byte)/i.test(s) &&
    /(json|duplicates_report|review\.html|embedded data|inline data)/i.test(s) &&
    /(size|large|bloated|too big|fetch\(|local file reference|separate file|violates|coupling|external)/i.test(s)
  );
}

export function parseCriticVerdict(rawText: string): { pass: boolean; defects: string[] } {
  const hadToolCall = /<tool_call>|<function=/i.test(rawText);
  const cleaned = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, "")
    .replace(/<function=[^>]*>[\s\S]*?(?:<\/function>|<\/tool_call>|$)/gi, "")
    .trim();
  if (!cleaned) return { pass: true, defects: [] };
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as { pass?: boolean; defects?: unknown[] };
      const rawDefects = Array.isArray(obj.defects)
        ? obj.defects.map((d) => String(d).trim()).filter((d) => d.length > 0)
        : [];
      const defects = rawDefects.filter((d) => !isFalsePositiveInlineDataDefect(d));
      if ((obj.pass === true || rawDefects.length > 0) && defects.length === 0) {
        return { pass: true, defects: [] };
      }
      if (defects.length > 0) return { pass: false, defects };
    } catch {
      // Fallback to text parsing.
    }
  }
  if (hadToolCall) return { pass: true, defects: [] };
  if (/^\s*PASS\b/i.test(cleaned)) return { pass: true, defects: [] };
  const bullets = cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim())
    .filter((l) => l.length > 8 && !/^\{|\}$/.test(l) && !/^<\/?(tool_call|function|parameter)/i.test(l))
    .filter((l) => !isFalsePositiveInlineDataDefect(l));
  return bullets.length > 0 ? { pass: false, defects: bullets.slice(0, 6) } : { pass: true, defects: [] };
}

async function runFreshCritic(ctx: ExtensionContext, focus: string): Promise<{ pass: boolean; defects: string[] } | null> {
  const ep = resolveCriticEndpoint(ctx);
  if (!ep) return null;

  const bundle = collectCriticBundle(ctx.cwd);
  const prompt = [
    "You are an independent, strict code reviewer in a clean context.",
    "CRITICAL: You have NO tools available. Do NOT output <tool_call>, <function=...>, XML tags, or requests to read files. Inspect ONLY the workspace listing and code provided below.",
    "Do NOT flag any file listed in 'Workspace inventory' as missing or absent solely because its excerpt below was trimmed to fit the critic budget.",
    "Do NOT complain about inline/embedded JSON size or advise replacing embedded data with fetch() for standalone single-file HTML deliverables meant to open directly via file://.",
    focus ? `Review focus: ${focus}` : "Inspect for concrete bugs, missing deliverables, bad DOM selectors, O(K^2) performance risks, or unhandled errors.",
    "Do NOT invent minor style complaints. Respond ONLY with raw JSON: {\"pass\": true, \"defects\": []} if solid, or {\"pass\": false, \"defects\": [\"...\"]} with up to 5 concrete defects.",
    "",
    bundle,
  ].join("\n");

  const body: Record<string, unknown> = {
    model: ep.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    top_p: 0.95,
    max_tokens: 1000,
    stream: false,
  };
  if (ep.provider === "inkling-local") {
    body.reasoning_effort = "low";
  } else if (ep.provider === "surogate-local" || ep.provider === "ornith-splash") {
    body.chat_template_kwargs = { enable_thinking: false, preserve_thinking: false };
    body.thinking_token_budget = 256;
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

export function shouldSkipAutoCriticForProvider(provider: string): boolean {
  return (
    String(provider || "").trim().toLowerCase() === "inkling-local" &&
    process.env.PI_LOCAL_AUTO_CRITIC_FORCE !== "1"
  );
}

export default function localCriticExtension(pi: ExtensionAPI) {
  let criticRanThisTask = false;
  let lastUserPrompt = "";
  let sessionActive = true;

  pi.on("session_start", () => {
    criticRanThisTask = false;
    lastUserPrompt = "";
    sessionActive = true;
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
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
      try {
        ctx.ui?.notify?.("Running fresh-context adversarial critic pass...", "info");
      } catch {
        // Ignore stale or headless UI contexts.
      }
      const verdict = await runFreshCritic(ctx, args.trim() || lastUserPrompt);
      if (!verdict) {
        try {
          ctx.ui?.notify?.("Critic pass could not reach active local server.", "warning");
        } catch {
          // Ignore UI notification error.
        }
        return;
      }
      appendLocalTrace("local-critic", "manual_critic", { pass: verdict.pass, defects: verdict.defects });
      if (verdict.pass) {
        try {
          ctx.ui?.notify?.("Critic verdict: PASS (no concrete defects found).", "info");
        } catch {
          // Ignore UI notification error.
        }
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

  pi.on("agent_end", async (_event, ctx) => {
    if (process.env.PI_LOCAL_AUTO_CRITIC !== "1") return;
    if (criticRanThisTask || !sessionActive) return;
    if (fs.existsSync(path.join(ctx.cwd, ".pi-handoff.md"))) return;

    const provider = String((ctx.model as { provider?: string } | undefined)?.provider || "");
    if (shouldSkipAutoCriticForProvider(provider)) {
      criticRanThisTask = true;
      appendLocalTrace("local-critic", "auto_critic_skipped_gdn", { provider });
      return;
    }

    criticRanThisTask = true;
    const verdict = await runFreshCritic(ctx, lastUserPrompt);
    if (!verdict || !sessionActive) return;
    appendLocalTrace("local-critic", "auto_critic", { pass: verdict.pass, defects: verdict.defects });
    if (!verdict.pass && verdict.defects.length > 0) {
      const g = globalThis as typeof globalThis & { __piLocalEscalation?: { offset: number; criticPending?: boolean } };
      if (g.__piLocalEscalation) {
        g.__piLocalEscalation.offset = Math.max(g.__piLocalEscalation.offset, 1);
        g.__piLocalEscalation.criticPending = true;
      }
      try {
        ctx.ui?.notify?.(
          `Auto-critic flagged ${verdict.defects.length} issue(s); sending repair pass...`,
          "info",
        );
      } catch {
        // Headless or shutting-down ctx must never crash on UI notify.
      }
      try {
        pi.sendUserMessage(
          `Independent fresh-context critic review flagged ${verdict.defects.length} defect(s):\n- ${verdict.defects.join("\n- ")}\n\nFix these specific issues and run a final verification check.`,
          { deliverAs: "followUp" },
        );
      } catch {
        // Ignore if session already terminated before follow-up dispatch.
      }
    }
  });
}
