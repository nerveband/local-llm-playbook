# Local LLM Best Practices (Apple Silicon + oMLX + Pi)

Living field guide for keeping local coding and data-analysis sessions fast, accurate, and free of mid-turn truncation while leaving enough unified RAM and GPU headroom for browsers and desktop work.

---

## 1. Hardware and Memory Budget (64 GiB M1 Max)

- **Inkling 2 Mini (`128K` context, `--slots 1`, `--hot-cache-max-size 6GB`, `--default-temp 0.6 --top-p 0.95 --repetition-penalty 1.0` on port `18089`):**
  - Active model + `64K` KV peak measured `24.39 GB` GPU RAM (`31,712` KV tokens add only `+0.91 GB` across `8` full-attention layers with `1024` sliding-window attention).
  - Use `--default-temp 0.6 --top-p 0.95 --repetition-penalty 1.0` instead of greedy `0.0` or `0.2`: low temperatures on looped MoE models can lock into verbatim copy loops across blocked commands, whereas keeping `repetition_penalty: 1.0` and `presence_penalty: 0.0` preserves code syntax and `<think>` logic.

### Qwen 3.8 27B + Inkling 2 Mini Sampling Lesson

Both Inkling 2 Mini (looped 24-layer MoE transformer) and dense/thinking coding models such as Qwen 3.8 27B rely on unconstrained token distributions inside `<think>` traces and structured code syntax:

- **Keep `repetition_penalty: 1.0` (disabled) and `presence_penalty: 0.0` during thinking mode.** Multiplicative repetition penalties (`> 1.0`) penalize repeated brackets, variable names, boilerplate syntax, and JSON/XML tool delimiters, which breaks syntax and degrades `<think>` chains.
- **Recommended per-mode defaults:**
  - **Inkling 2 Mini (`oMLX`):** `--default-temp 0.6`, `--top-p 0.95`, `top_k: 0`, `--repetition-penalty 1.0`, `presence_penalty: 0.0` (matches `temp 0.6` / `top_p 0.95` stability without greedy copy loops).
  - **Qwen 3.8 27B (Thinking mode):** `temperature: 1.0`, `top_p: 0.95`, `top_k: 20`, `repetition_penalty: 1.0`, `presence_penalty: 0.0` (with `preserve_thinking` kept enabled across turns).
  - **Qwen 3.8 27B (Non-thinking Instruct mode):** `temperature: 0.7`, `top_p: 0.80`, `top_k: 20`, `presence_penalty: 1.5`, `repetition_penalty: 1.0`.
- **Pair sampling with harness checks:** Use the **Adversarial Self-Check** rule in `prompts/local-lean-rules.md` to counter author confirmation bias, and count repeats even on blocked heredocs in `local-context-guard.ts`.
  - Inkling supports 7 native `reasoning_effort` levels in `chat_template.jinja`:

| Pi thinking level | Sent `reasoning_effort` | Numeric effort | Notes |
| --- | --- | ---: | --- |
| `off` | `none` | `0.0` | Thinking disabled |
| `minimal` | `minimal` | `0.1` | Shortest thinking trace |
| `low` | `low` | `0.2` | Light thinking |
| `medium` | `medium` | `0.7` | Default in `pi-local --inkling` |
| `high` | `high` | `0.9` | Deeper reasoning, more thinking tokens |
| `xhigh` | `xhigh` | `0.99` | Near-maximum thinking budget |
| `max` | `max` | `0.99` | Same effort cap as `xhigh` |

  - Live `32K` to `46K` sessions sustain `94%+` prefix cache efficiency inside ~`4.4 GB` of hot cache. Capping hot cache at `6GB` keeps cache hits high while preventing **oMLX** soft memory pressure (`~29 GB` warning) and prefill throttling when desktop apps use ~`27 GB` on a `64 GiB` Mac.
- **Ornith 1.5 35B-A3B (`38 GB` resident budget via `splash-1.7.0-m1` + desktop **oMLX** on port `8000`):**
  - Stop Inkling (`inkling-omlx stop`) before opening **oMLX** for Ornith, and unload Ornith before heavy Inkling sessions.
  - Running **either Inkling or Ornith one at a time** keeps browser tabs and desktop apps responsive with zero memory thrashing.
  - `pi-local` automatically checks ports `18089` and `8000` at startup and prints a warning if both local servers are running at the same time.
- **Keep `--slots 1`:** Doubling slots splits memory bandwidth and allocates extra concurrent KV state, slowing single-user interactive speed.
- **Surogate 3.7 Flash (`128K`, `bf16` KV/state, **Splash** + DFlash2 on port `18091`):**
  - Fine-tuned on **Qwen3.5-35B-A3B-Base** (35B total / 3B active MoE family shared with Qwen3.6-35B-A3B).
  - Recommended coding-agent settings injected automatically for `surogate-local` by `local-omlx-meter.ts` when unset: `temperature: 0.65`, `top_p: 0.95`, `top_k: 20`, plus `preserve_thinking: true` whenever `enable_thinking` is true so multi-turn agent reasoning carries across turns without losing context, paired with `--thinking-token-budget 2048` in **Splash** and **Rule 8 (Action bias)** in `prompts/local-lean-rules.md`.

---

## 2. Compaction and Thinking Budget Math

Mid-turn truncation (`Response was truncated before completion` / `finish_reason=length`) happens when `compaction.reserveTokens` is smaller than `maxTokens`:

- **Inkling (`contextWindow: 131072`, `maxTokens: 32768`):**
  - `reserveTokens: 36864` triggers clean compaction between tool calls around `94,208` tokens (`71.9%`), guaranteeing a full `32,768`-token output runway on every turn so multi-file builds never hit mid-turn `finish_reason=length` truncation after deep thinking.
  - `keepRecentTokens: 12000` keeps the post-compaction slice tight so cold prefill finishes fast.
  - `modelThinkingLevels["inkling-local/inkling"] = "medium"` avoids burning 3,000+ thinking tokens on simple file reads. Pass `pi-local --inkling --think low` when executing a complete pre-written UI/script spec so Inkling does not burn `10K+` thinking tokens before writing code.
- **Ornith (`contextWindow: 262144`, `maxTokens: 32768`):**
  - `reserveTokens: 131072` compacts cleanly halfway (`131,072` tokens) with `32,768` output headroom intact, keeping decode near peak speed and KV RAM bounded.
  - `modelThinkingLevels["omlx-local/Ornith-1.5-35B-A3B-Abliterated-MLX-4bit"] = "high"` keeps thinking on by default; pass `pi-local --ornith --no-think` when you want fast direct code or prose generation.

---

## 3. Self-Triggered Phase Boundaries (`phase_handoff` + `/next-phase`)

Instead of letting a single long run hit emergency compaction, let the model switch phases cleanly on disk:

- `extensions/local-phase-handoff.ts` gives the model a `phase_handoff` tool that writes `.pi-handoff.md` with the completed summary (including exact verified column names and JSON schema keys), key files on disk (`notes.md`, scripts, JSON outputs), an optional `next_thinking_level` recommendation (`low` for straightforward UI/CSV/script builds, `medium` for analysis or debugging), and the exact next-phase task.
- At `32,000` tokens (or `72%` of the window, whichever comes first), a `tool_result` notice whispers once to the model to wrap up `notes.md` and call `phase_handoff` at the next milestone before long-context decode slows down (uses a `message_end` `input + cacheRead + output` fallback when `ctx.getContextUsage()` under-reports on **Splash**).
- `extensions/local-context-guard.ts` trims oversized noisy `bash`/`grep`/`find`/`ls` (`>6,000` chars / `120` lines), explicit `sed -n` line-range slices (`>12,000` chars / `220` lines), and `read` (`>20,000` chars / `400` lines) outputs at insertion time while keeping skill/reference/instruction docs (`SKILL.md`, `notes.md`, `PROMPT.md`, `/skills*/`, `/reference/*.md`) intact up to `36,000` chars and spilling trimmed logs to `/tmp/pi-local-tool-logs` so context grows slowly without mutating prior history. It also hashes every tool call with `sha256` before blocking checks (warns on the `2nd` identical call in a row, escalates on repeated blocked heredocs, blocks the `3rd` identical call), blocks `/tmp/*.py` scratch `write` calls, blocks `>= 800`-char inline `python3 -c` scripts and `>= 5` consecutive inline `python3 -c` probe streaks, allows `cat >> notes.md` heredoc appends up to `2,500` chars while hard-blocking other `>= 1,000`-char `bash` heredocs, and emits separate nudges after `3` consecutive inline `python3 -c` probes vs `3` consecutive shell `cat`/`head`/`tail`/`sed` reads.
- **Two modes controlled by `auto_continue` (and per-phase thinking switching):**
  - `auto_continue: false` (default): Model writes `.pi-handoff.md`, stops calling tools, and waits so you can inspect deliverables and run `/next-phase` (or `/next-phase --think low`) when ready.
  - `auto_continue: true`: When you want hands-free execution across phases, `agent_end` automatically runs `/next-phase` (`ctx.newSession`), switches thinking via `pi.setThinkingLevel()` cleanly at session Turn 0 when `next_thinking_level` is set, and starts the next phase in a fresh window without filling context (capped at `3` auto-hops per run for loop safety).

---

## 4. Protecting the oMLX Prefix Cache

Hybrid architectures using sliding-window attention and recurrent GDN layers require exact prefix matching from token `0`:

- **Keep chat history append-only during a task.** Avoid extensions that rewrite, edit, or delete earlier assistant/tool messages mid-session, because mutating earlier tokens forces a `1` to `2` minute cold re-prefill in **oMLX**.
- **Keep static system prompts small and stable.** Stripping global MCPs, skills, `codemode`, and cloud tools via `pi-local` drops turn-1 base tokens from `11,328` down to `4,974` (`pi-local`), `2,376` (`pi-local --bare`), or `1,846` (`pi-local --bare --no-phase-tool`).
- **Pick thinking level per phase, not per turn.** Inkling's `chat_template.jinja` renders `Thinking effort level: <num>` right before user turn 1. Toggling thinking mid-session (`Shift+Tab`) changes an early token, forcing one full re-prefill of the current history (turns after that re-cache at the new level). Launch with `--think low` or `--no-think` for mechanical UI/script passes, and `--think medium` for tricky investigation.
- **Avoid `/reload` mid-session.** Changing tools or prompts mid-run shifts the prefix and invalidates cached KV blocks.
- **oMLX `0.8.2` prefix-cache caveats observed in practice:**
  - Rare large `write` tool calls (`10K`+ tokens) can diverge on the next turn inside the replayed tool-call JSON if **oMLX** re-serializes keys or escaping differently from what the model originally generated (`dictsort` + `tojson` in Jinja templates). Keep written Python scripts concise (`250` to `350` lines) and patch iteratively with `edit` so even a rare replay mismatch re-prefills only `2K` to `3K` tokens instead of `14K`+.
  - On fresh-session Turn 1 (after `/next-phase`), **oMLX `0.8.2`** may still re-prefill the full Turn-1 prompt (`reused 0`) even when the first `~5,600` system/tools tokens match an earlier session, because of its shared-tail cache cutoff.

---

## 5. Plugin and Harness Compatibility Matrix

| Tool / Extension | Role on Local oMLX | Prefix-Cache Safe? | Recommendation |
| --- | --- | --- | --- |
| `local-phase-handoff.ts` | Self-triggered `phase_handoff` tool + `/next-phase` + `32K` notice | Yes (appends once or starts fresh session) | **Enabled by default in `pi-local`** |
| `local-context-guard.ts` | Insertion-time output cap + `/tmp` log spill + `sha256` loop guard + heredoc/error hints | Yes (edits before insertion, never mutates prior turns) | **Enabled by default in `pi-local`** |
| `local-omlx-meter.ts` | Per-turn timer + prefill/tool-buffering status + oMLX server stats | Yes | **Enabled by default in `pi-local`** |
| `pi-handoff` | Manual `/handoff` command into a new session | Yes (fresh session) | **Enabled in `pi-local`** |
| `pi-continue` | Compacts safely before overflow using a disk ledger | Yes (native cut point) | Removed (deprecated `0.9.3`; aborted active local turns around `50%` / `65K` context). Use `local-phase-handoff.ts` + `/handoff` instead. |
| `pi-subagents` | Isolates noisy exploration into child sessions | Yes (isolated runs) | **Use sequentially (`pi-local --subagents`)** |
| `pi-tool-repair` / `@erichll/pi-statusline` | Repairs malformed tool JSON and renders footer status | Yes | **Keep enabled in `pi-local`** |
| `pi-token-speed` (legacy) | Client chunk counter; undercounts MTP bursts and buffers | Yes | Replaced by `local-omlx-meter.ts` (`--legacy-speed`) |
| Mid-history pruners (`pi-smart-compact`, `pi-context-kit`, `cprune`) | Deletes old tool outputs from earlier turns | No (breaks prefix from token 0) | Best for cloud APIs, skip for hybrid local **oMLX** models |
| `rtk` (CLI output compressor) | Compresses verbose shell stdout before entering history | Yes | Good companion for heavy build/test logs |

---

## 6. Subagent Concurrency Rules

- **Simultaneous local generations:** **`1` at a time** on `--slots 1`. Parallel local subagents contend for M1 Max memory bandwidth.
- **Sequential local subagents per project:** **`3` to `5` focused child stages** (for example: Stage 1 schema profiler, Stage 2 data pipeline, Stage 3 verification pass, Stage 4 HTML report builder). Each child starts small (`1.8K` to `6.8K` base tokens), works quickly, writes artifacts to disk, and returns a short summary so the parent never overflows.
- **Hybrid local + cloud workflow:** Run `1` local Inkling subagent alongside `3` to `5` parallel cloud subagents (fast small/flash cloud models) for web lookups or parallel code reviews.
- Set child subagents to **`low` thinking** unless deep reasoning is specifically needed.

---

## 7. Progressive Disclosure and Disk Memory

1. **Always create `notes.md` early.** Record verified column spellings, key counts, edge cases, generated file paths, and open TODOs. After any `/next-phase`, `/handoff`, or compaction, read `notes.md` first.
2. **Never dump raw CSVs or giant JSON blobs into stdout.** Write scripts that inspect schema + row counts + `3` to `5` sample rows, compute distributions in Python, and write full outputs to disk (`results.json`, `review.html`). Cap printed summaries under `20` lines.
3. **Write concise scripts and modular `.css`/`.html`/`.js` assets with `write`/`edit`.** Never embed large HTML/CSS/JS bundles inside one Python string, and avoid bash heredocs (`<<EOF`). Split UI outputs into separate template files (`<= 300` lines each) plus a tiny builder script so every `write` stays well under output limits.
4. **Reset sessions around `32K` tokens.** Use `--think low` (`Shift+Tab`) when executing pre-written UI or script specs (`~50%` faster turns and zero thinking bloat), and let `phase_handoff` + `/next-phase` carry `next_thinking_level` across fresh sessions.
