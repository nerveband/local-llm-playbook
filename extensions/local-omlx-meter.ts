import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { appendLocalTrace } from "./local-trace.ts";

const THINKING_TIER_LADDER = ["minimal", "low", "medium", "high"] as const;

export function resolveEscalatedThinkingLevel(
  baseLevel: string | undefined,
  escalationOffset: number,
): string | undefined {
  const clean = String(baseLevel || "").trim().toLowerCase();
  const idx = THINKING_TIER_LADDER.indexOf(clean as (typeof THINKING_TIER_LADDER)[number]);
  if (idx === -1) return baseLevel;
  const nextIdx = Math.min(THINKING_TIER_LADDER.length - 1, Math.max(0, idx + Math.max(0, escalationOffset)));
  return THINKING_TIER_LADDER[nextIdx];
}

const STATUS_KEY = "local-omlx-meter";
const TICK_INTERVAL_MS = 500;
const ROLLING_WINDOW_MS = 2500;
const BUFFERING_SILENCE_MS = 2500;
const TOKEN_REGEX = /\w+|[^\s\w]/g;

const SPEED_TIERS = [
  { min: 45, hex: "#44ddff" },
  { min: 30, hex: "#00ff88" },
  { min: 15, hex: "#ffaa00" },
  { min: 0, hex: "#ff4444" },
];

interface ServerTurnStats {
  genTps?: number;
  prefillTps?: number;
  ttftSec?: number;
  visibleTtftSec?: number;
  genDurationSec?: number;
  totalTimeSec?: number;
  completionTokens?: number;
  promptTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

interface OmlxStatusSnapshot {
  avgGenTps?: number;
  avgPrefillTps?: number;
  cacheEfficiency?: number;
  memoryUsed?: string;
}

interface TokenEvent {
  time: number;
  tokens: number;
}

function colorizeTps(text: string, tps: number): string {
  const tier = SPEED_TIERS.find((entry) => tps >= entry.min);
  if (!tier) return text;
  const r = Number.parseInt(tier.hex.slice(1, 3), 16);
  const g = Number.parseInt(tier.hex.slice(3, 5), 16);
  const b = Number.parseInt(tier.hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export function estimateDeltaTokens(delta: string): number {
  if (!delta) return 0;
  const matches = delta.match(TOKEN_REGEX);
  const regexCount = matches ? matches.length : 0;
  const charEstimate = Math.ceil(delta.length / 4);
  return Math.max(1, regexCount, charEstimate);
}

export function isLocalProviderModel(model: ExtensionContext["model"]): boolean {
  if (!model) return false;
  const provider = String(model.provider || "").toLowerCase();
  if (
    provider === "inkling-local" ||
    provider === "surogate-local" ||
    provider === "ornith-splash" ||
    provider === "omlx-local" ||
    provider === "omlx" ||
    provider.endsWith("-local")
  ) {
    return true;
  }
  const baseUrl = String((model as { baseUrl?: string }).baseUrl || "");
  return (
    baseUrl.startsWith("http://127.0.0.1") ||
    baseUrl.startsWith("http://localhost")
  );
}

export function isSplashProvider(provider: string): boolean {
  return provider === "surogate-local" || provider === "ornith-splash";
}

export function resolveSplashThinkingBudget(level: string | undefined): number | undefined {
  switch (String(level || "").trim().toLowerCase()) {
    case "minimal":
      return 512;
    case "low":
      return 1024;
    case "medium":
      return 1536;
    case "high":
      return 2048;
    case "xhigh":
    case "max":
      return 4096;
    default:
      return undefined;
  }
}

export function resolveServerOrigin(model: ExtensionContext["model"]): string | null {
  const baseUrl = String((model as { baseUrl?: string } | undefined)?.baseUrl || "");
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      // Fall back to provider defaults below.
    }
  }
  const provider = String(model?.provider || "").toLowerCase();
  if (provider === "inkling-local") return "http://127.0.0.1:18089";
  if (provider === "surogate-local") return "http://127.0.0.1:18091";
  if (provider === "ornith-splash") return "http://127.0.0.1:18092";
  if (provider === "omlx-local" || provider === "omlx") return "http://127.0.0.1:8000";
  return null;
}

function mergeDefinedStats(
  base: ServerTurnStats | null,
  incoming: ServerTurnStats | null,
): ServerTurnStats | null {
  if (!incoming) return base;
  const merged: ServerTurnStats = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== undefined) {
      (merged as Record<string, number>)[k] = v as number;
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

export function extractServerStatsFromTimings(timings: unknown): ServerTurnStats | null {
  if (!timings || typeof timings !== "object") return null;
  const t = timings as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const val = t[key];
    return typeof val === "number" && Number.isFinite(val) ? val : undefined;
  };
  const promptMs = num("prompt_ms");
  const predMs = num("predicted_ms");
  let totalTimeSec: number | undefined;
  if (promptMs !== undefined || predMs !== undefined) {
    totalTimeSec = Math.max(0, (promptMs ?? 0) + (predMs ?? 0)) / 1000;
  }
  const stats: ServerTurnStats = {
    genTps: num("predicted_per_second"),
    prefillTps: num("prompt_per_second"),
    ttftSec: promptMs !== undefined && promptMs >= 0 ? promptMs / 1000 : undefined,
    genDurationSec: predMs !== undefined && predMs > 0 ? predMs / 1000 : undefined,
    totalTimeSec,
    completionTokens: num("predicted_n"),
    promptTokens: num("prompt_n"),
    cachedTokens: num("cache_n"),
  };
  const hasAny = Object.values(stats).some((v) => v !== undefined);
  return hasAny ? stats : null;
}

export function extractServerStatsFromUsage(usage: unknown): ServerTurnStats | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const val = u[key];
    return typeof val === "number" && Number.isFinite(val) ? val : undefined;
  };
  const promptDetails = (u.prompt_tokens_details && typeof u.prompt_tokens_details === "object")
    ? (u.prompt_tokens_details as Record<string, unknown>)
    : null;
  const completionDetails = (u.completion_tokens_details && typeof u.completion_tokens_details === "object")
    ? (u.completion_tokens_details as Record<string, unknown>)
    : null;

  const stats: ServerTurnStats = {
    genTps: num("generation_tokens_per_second"),
    prefillTps: num("prompt_tokens_per_second"),
    ttftSec: num("time_to_first_token"),
    visibleTtftSec: num("time_to_first_visible_token"),
    genDurationSec: num("generation_duration"),
    totalTimeSec: num("total_time"),
    completionTokens: num("completion_tokens"),
    promptTokens: num("prompt_tokens"),
    cachedTokens:
      promptDetails && typeof promptDetails.cached_tokens === "number"
        ? promptDetails.cached_tokens
        : undefined,
    reasoningTokens:
      completionDetails && typeof completionDetails.reasoning_tokens === "number"
        ? completionDetails.reasoning_tokens
        : undefined,
  };

  const hasAny = Object.values(stats).some((v) => v !== undefined);
  return hasAny ? stats : null;
}

export default function localOmlxMeterExtension(pi: ExtensionAPI) {
  let disposed = false;
  let activeTurn = false;
  let turnStartMs = 0;
  let firstDeltaMs: number | null = null;
  let lastDeltaMs: number | null = null;
  let lastEndMs = 0;
  let phase: "prefill" | "thinking" | "text" | "tool" = "prefill";

  let estTokens = 0;
  let countedProviderOutput = 0;
  let recentEvents: TokenEvent[] = [];

  let activeToolNames: string[] = [];
  let turnServerStats: ServerTurnStats | null = null;
  let latestStatusSnapshot: OmlxStatusSnapshot | null = null;
  let lastCompletedSummary: string | null = null;
  let lastCtx: ExtensionContext | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let statusEndpointUnsupported = false;

  function safeSetStatus(ctx: ExtensionContext | null, text: string | undefined): void {
    if (disposed || !ctx) return;
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // Ignore stale ExtensionContext after session shutdown or replacement.
    }
  }

  function stopTicker(): void {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function startTicker(ctx: ExtensionContext): void {
    stopTicker();
    lastCtx = ctx;
    ticker = setInterval(() => {
      if (disposed || !activeTurn || !lastCtx) {
        stopTicker();
        return;
      }
      renderLive(lastCtx);
    }, TICK_INTERVAL_MS);
    if (typeof (ticker as { unref?: () => void }).unref === "function") {
      (ticker as { unref: () => void }).unref();
    }
  }

  function resetTurn(now: number): void {
    activeTurn = true;
    turnStartMs = now;
    firstDeltaMs = null;
    lastDeltaMs = null;
    lastEndMs = 0;
    phase = "prefill";
    estTokens = 0;
    countedProviderOutput = 0;
    recentEvents = [];
    activeToolNames = [];
    turnServerStats = null;
  }

  function computeRollingTps(now: number): number {
    const cutoff = now - ROLLING_WINDOW_MS;
    while (recentEvents.length > 0 && recentEvents[0].time < cutoff) {
      recentEvents.shift();
    }
    if (recentEvents.length === 0) return 0;

    let windowTokens = 0;
    for (const evt of recentEvents) {
      windowTokens += evt.tokens;
    }

    const windowSpanMs = now - recentEvents[0].time;
    if (windowSpanMs >= 250) {
      return (windowTokens * 1000) / windowSpanMs;
    }

    if (firstDeltaMs !== null) {
      const decodeSec = Math.max(0.25, (now - firstDeltaMs) / 1000);
      return estTokens / decodeSec;
    }

    return 0;
  }

  function renderLive(ctx: ExtensionContext): void {
    if (disposed) return;
    const now = Date.now();
    const turnSec = Math.max(0, (now - turnStartMs) / 1000);

    if (activeToolNames.length > 0 && lastCompletedSummary) {
      safeSetStatus(ctx, `${lastCompletedSummary} · ⚙ ${activeToolNames[0]}`);
      return;
    }

    if (!activeTurn) {
      if (lastCompletedSummary) {
        safeSetStatus(ctx, lastCompletedSummary);
      }
      return;
    }

    if (firstDeltaMs === null) {
      const label = turnSec < 8 ? "prefill" : "prefill/tool-buf";
      safeSetStatus(ctx, `⚡ ${label} ${turnSec.toFixed(1)}s`);
      return;
    }

    const ttftSec = Math.max(0, (firstDeltaMs - turnStartMs) / 1000);
    if (lastDeltaMs !== null && now - lastDeltaMs >= BUFFERING_SILENCE_MS) {
      const silentSec = (now - lastDeltaMs) / 1000;
      safeSetStatus(
        ctx,
        `⚡ tool-buf ${silentSec.toFixed(1)}s · turn ${turnSec.toFixed(1)}s (TTFT ${ttftSec.toFixed(1)}s)`,
      );
      return;
    }

    const liveTps = computeRollingTps(now);
    const tpsText = colorizeTps(`${liveTps.toFixed(1)} tok/s`, liveTps);
    safeSetStatus(
      ctx,
      `⚡ ${tpsText} · ${turnSec.toFixed(1)}s (TTFT ${ttftSec.toFixed(1)}s · ${phase})`,
    );
  }

  function formatCompletedSummary(
    finalTps: number | null,
    turnSec: number,
    ttftSec: number | null,
    outTok: number,
    prefillTps?: number,
  ): string {
    const tpsPart =
      finalTps !== null && Number.isFinite(finalTps) && finalTps > 0
        ? colorizeTps(`${finalTps.toFixed(1)} tok/s`, finalTps)
        : "-- tok/s";
    const details: string[] = [];
    if (ttftSec !== null && Number.isFinite(ttftSec)) {
      details.push(`TTFT ${ttftSec.toFixed(1)}s`);
    }
    if (outTok > 0) {
      details.push(`${outTok} tok`);
    }
    if (prefillTps !== undefined && prefillTps > 0) {
      details.push(`prefill ${Math.round(prefillTps)}`);
    } else if (latestStatusSnapshot?.avgPrefillTps && latestStatusSnapshot.avgPrefillTps > 0) {
      details.push(`prefill ${Math.round(latestStatusSnapshot.avgPrefillTps)}`);
    }
    if (latestStatusSnapshot?.cacheEfficiency !== undefined) {
      details.push(`cache ${Math.round(latestStatusSnapshot.cacheEfficiency)}%`);
    }
    if (latestStatusSnapshot?.memoryUsed) {
      details.push(latestStatusSnapshot.memoryUsed);
    }

    const suffix = details.length > 0 ? ` (${details.join(" · ")})` : "";
    return `⚡ ${tpsPart} · ${turnSec.toFixed(1)}s${suffix}`;
  }

  async function refreshOmlxStatus(ctx: ExtensionContext): Promise<OmlxStatusSnapshot | null> {
    if (disposed || statusEndpointUnsupported) return null;
    if (!isLocalProviderModel(ctx.model)) return null;
    const provider = String(ctx.model?.provider || "").toLowerCase();
    if (provider === "surogate-local" || provider === "ornith-splash") return null;
    const origin = resolveServerOrigin(ctx.model);
    if (!origin) return null;

    try {
      const response = await fetch(`${origin}/api/status`, {
        signal: AbortSignal.timeout(800),
      });
      if (response.status === 404) {
        statusEndpointUnsupported = true;
        return null;
      }
      if (disposed || !response.ok) return null;
      const body = (await response.json()) as Record<string, unknown>;
      if (disposed) return null;
      const snapshot: OmlxStatusSnapshot = {
        avgGenTps:
          typeof body.avg_generation_tps === "number" ? body.avg_generation_tps : undefined,
        avgPrefillTps:
          typeof body.avg_prefill_tps === "number" ? body.avg_prefill_tps : undefined,
        cacheEfficiency:
          typeof body.cache_efficiency === "number" ? body.cache_efficiency : undefined,
        memoryUsed:
          typeof body.model_memory_used_formatted === "string"
            ? body.model_memory_used_formatted
            : undefined,
      };
      latestStatusSnapshot = snapshot;
      return snapshot;
    } catch {
      return null;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    disposed = false;
    lastCtx = ctx;
    stopTicker();
    activeTurn = false;
    lastCompletedSummary = null;
    latestStatusSnapshot = null;
    statusEndpointUnsupported = false;
    safeSetStatus(ctx, "⚡ --");
  });

  pi.on("model_select", (_event, ctx) => {
    lastCtx = ctx;
    latestStatusSnapshot = null;
    statusEndpointUnsupported = false;
  });

  pi.on("before_provider_request", (event, ctx) => {
    lastCtx = ctx;
    if (!isLocalProviderModel(ctx.model)) return;
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return;

    const provider = String(ctx.model?.provider || "").toLowerCase();
    const nextPayload: Record<string, unknown> = { ...payload };
    let changed = false;

    if (
      provider === "surogate-local" ||
      provider === "ornith-splash" ||
      provider === "omlx-local" ||
      provider === "omlx"
    ) {
      if (nextPayload.temperature === undefined) {
        nextPayload.temperature = 0.65;
        changed = true;
      }
      if (nextPayload.top_p === undefined) {
        nextPayload.top_p = 0.95;
        changed = true;
      }
      if (nextPayload.top_k === undefined) {
        nextPayload.top_k = 20;
        changed = true;
      }
      if (nextPayload.presence_penalty === undefined) {
        nextPayload.presence_penalty = 0.0;
        changed = true;
      }
    }

    if (isSplashProvider(provider)) {
      const rawKwargs =
        nextPayload.chat_template_kwargs && typeof nextPayload.chat_template_kwargs === "object"
          ? (nextPayload.chat_template_kwargs as Record<string, unknown>)
          : undefined;
      if (rawKwargs?.enable_thinking === true || nextPayload.enable_thinking === true) {
        if (rawKwargs?.preserve_thinking !== true) {
          nextPayload.chat_template_kwargs = {
            ...(rawKwargs ?? {}),
            preserve_thinking: true,
          };
          changed = true;
        }
        if (nextPayload.thinking_token_budget === undefined) {
          const baseLevel =
            typeof (pi as { getThinkingLevel?: () => string }).getThinkingLevel === "function"
              ? (pi as { getThinkingLevel: () => string }).getThinkingLevel()
              : undefined;
          const g = globalThis as typeof globalThis & { __piLocalEscalation?: { offset?: number } };
          const adaptiveEnabled = process.env.PI_LOCAL_ADAPTIVE_THINK === "1";
          const effectiveLevel = adaptiveEnabled
            ? resolveEscalatedThinkingLevel(baseLevel, Number(g.__piLocalEscalation?.offset || 0))
            : baseLevel;
          const budget = resolveSplashThinkingBudget(effectiveLevel);
          if (budget !== undefined) {
            nextPayload.thinking_token_budget = budget;
            changed = true;
          }
        }
      }
    }

    if (nextPayload.stream === true) {
      const existing =
        nextPayload.stream_options && typeof nextPayload.stream_options === "object"
          ? (nextPayload.stream_options as Record<string, unknown>)
          : {};
      if (existing.include_usage !== true) {
        nextPayload.stream_options = {
          ...existing,
          include_usage: true,
        };
        changed = true;
      }
    }

    return changed ? nextPayload : undefined;
  });

  pi.on("turn_start", (event, ctx) => {
    const startMs =
      typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
        ? event.timestamp
        : Date.now();
    resetTurn(startMs);
    lastCtx = ctx;
    renderLive(ctx);
    startTicker(ctx);
  });

  pi.on("provider_stream_event", (event) => {
    if (!event || !event.data || typeof event.data !== "object") return;
    const chunk = event.data as Record<string, unknown>;
    const fromUsage = extractServerStatsFromUsage(chunk.usage);
    const fromTimings = extractServerStatsFromTimings(chunk.timings);
    turnServerStats = mergeDefinedStats(turnServerStats, fromUsage);
    turnServerStats = mergeDefinedStats(turnServerStats, fromTimings);
  });

  pi.on("message_update", (event, ctx) => {
    lastCtx = ctx;
    const now = Date.now();
    if (!activeTurn) {
      resetTurn(now);
      startTicker(ctx);
    }

    const ame = event.assistantMessageEvent as AssistantMessageEvent | undefined;
    if (!ame) return;

    if (
      ame.type === "thinking_start" ||
      ame.type === "text_start" ||
      ame.type === "toolcall_start"
    ) {
      if (firstDeltaMs === null) {
        firstDeltaMs = now;
      }
      lastDeltaMs = now;
      phase =
        ame.type === "thinking_start"
          ? "thinking"
          : ame.type === "toolcall_start"
            ? "tool"
            : "text";
      renderLive(ctx);
      return;
    }

    if (
      ame.type === "thinking_delta" ||
      ame.type === "text_delta" ||
      ame.type === "toolcall_delta"
    ) {
      if (firstDeltaMs === null) {
        firstDeltaMs = now;
      }
      lastDeltaMs = now;
      phase =
        ame.type === "thinking_delta"
          ? "thinking"
          : ame.type === "toolcall_delta"
            ? "tool"
            : "text";

      const partialUsageOut = (ame as { partial?: { usage?: { output?: number } } }).partial
        ?.usage?.output;
      let deltaTokens = 0;
      if (typeof partialUsageOut === "number" && partialUsageOut > countedProviderOutput) {
        deltaTokens = partialUsageOut - countedProviderOutput;
        countedProviderOutput = partialUsageOut;
      } else {
        const rawDelta = typeof (ame as { delta?: string }).delta === "string" ? (ame as { delta: string }).delta : "";
        deltaTokens = estimateDeltaTokens(rawDelta);
      }

      if (deltaTokens > 0) {
        estTokens += deltaTokens;
        recentEvents.push({ time: now, tokens: deltaTokens });
      }
      renderLive(ctx);
    }
  });

  pi.on("message_end", (event, ctx) => {
    lastCtx = ctx;
    const msg = event.message as Partial<AssistantMessage> | undefined;
    if (!msg || msg.role !== "assistant") return;

    const now = Date.now();
    lastEndMs = now;
    activeTurn = false;
    stopTicker();

    const usageOut =
      msg.usage && typeof msg.usage.output === "number" ? msg.usage.output : 0;
    const serverStats = turnServerStats;

    const outTok = serverStats?.completionTokens ?? (usageOut > 0 ? usageOut : estTokens);
    const turnSec =
      serverStats?.totalTimeSec ??
      (turnStartMs > 0 ? Math.max(0.01, (now - turnStartMs) / 1000) : 0);
    const ttftSec =
      serverStats?.ttftSec ??
      (firstDeltaMs !== null && turnStartMs > 0
        ? Math.max(0, (firstDeltaMs - turnStartMs) / 1000)
        : null);

    let finalTps: number | null = serverStats?.genTps ?? null;
    if (finalTps === null && outTok > 0) {
      if (serverStats?.genDurationSec && serverStats.genDurationSec > 0) {
        finalTps = outTok / serverStats.genDurationSec;
      } else if (firstDeltaMs !== null) {
        const decodeSec = Math.max(0.1, (now - firstDeltaMs) / 1000);
        finalTps = outTok / decodeSec;
      } else if (turnSec > 0) {
        finalTps = outTok / turnSec;
      }
    }

    lastCompletedSummary = formatCompletedSummary(
      finalTps,
      turnSec,
      ttftSec,
      outTok,
      serverStats?.prefillTps,
    );
    safeSetStatus(ctx, lastCompletedSummary);

    appendLocalTrace("local-omlx-meter", "turn_end", {
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      turnSec: Number(turnSec.toFixed(2)),
      ttftSec: ttftSec !== null ? Number(ttftSec.toFixed(2)) : null,
      genTps: finalTps !== null && Number.isFinite(finalTps) ? Number(finalTps.toFixed(1)) : null,
      prefillTps: serverStats?.prefillTps ?? null,
      promptTokens: serverStats?.promptTokens ?? null,
      cachedTokens: serverStats?.cachedTokens ?? null,
      outputTokens: outTok,
      reasoningTokens: serverStats?.reasoningTokens ?? null,
    });

    const completedTurnStamp = now;
    void refreshOmlxStatus(ctx).then((snapshot) => {
      if (disposed || !snapshot || activeTurn || lastEndMs !== completedTurnStamp) return;
      lastCompletedSummary = formatCompletedSummary(
        finalTps,
        turnSec,
        ttftSec,
        outTok,
        serverStats?.prefillTps,
      );
      if (activeToolNames.length > 0) {
        safeSetStatus(ctx, `${lastCompletedSummary} · ⚙ ${activeToolNames[0]}`);
      } else {
        safeSetStatus(ctx, lastCompletedSummary);
      }
    });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    lastCtx = ctx;
    activeTurn = false;
    stopTicker();
    if (event.toolName && !activeToolNames.includes(event.toolName)) {
      activeToolNames.push(event.toolName);
    }
    if (lastCompletedSummary) {
      safeSetStatus(ctx, `${lastCompletedSummary} · ⚙ ${event.toolName}`);
    } else {
      safeSetStatus(ctx, `⚡ ⚙ ${event.toolName}`);
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    lastCtx = ctx;
    activeToolNames = activeToolNames.filter((name) => name !== event.toolName);
    if (!activeTurn && lastCompletedSummary) {
      safeSetStatus(
        ctx,
        activeToolNames.length > 0
          ? `${lastCompletedSummary} · ⚙ ${activeToolNames[0]}`
          : lastCompletedSummary,
      );
    }
  });

  pi.on("session_compact", () => {
    activeTurn = false;
    stopTicker();
  });

  pi.on("agent_end", (_event, ctx) => {
    lastCtx = ctx;
    activeTurn = false;
    activeToolNames = [];
    stopTicker();
    if (lastCompletedSummary) {
      safeSetStatus(ctx, lastCompletedSummary);
    }
  });

  pi.on("agent_settled", () => {
    activeTurn = false;
    activeToolNames = [];
    stopTicker();
  });

  pi.on("session_shutdown", () => {
    disposed = true;
    activeTurn = false;
    activeToolNames = [];
    lastCtx = null;
    stopTicker();
  });
}
