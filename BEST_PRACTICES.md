# Local LLM Best Practices (Apple Silicon + oMLX + Pi)

Living field guide for keeping local coding and data-analysis sessions fast, accurate, and free of mid-turn truncation while leaving enough unified RAM and GPU headroom for browsers and desktop work.

---

## 1. Hardware and Memory Budget (64 GiB M1 Max)

- **Inkling 2 Mini (`128K` context, `oMLX 0.8.2 + m1_overlay`, `depth=6 + suffix_policy + --m1-fast + --affine4`, `--slots 1`, `--hot-cache-max-size 6GB`, `--default-temp 0.6 --top-p 0.95 --repetition-penalty 1.0` on port `18089`):**
  - Calibrated float `reasoning_effort` (`low: "0.25"`, `medium: "0.50"`, `high: "0.75"`, `xhigh/max: "0.99"`) replaces `"medium"` (`0.7`) so simple turns avoid excessive thinking tokens while retaining MTP speedup (`40.0 tok/s` micro-benchmark overall, up to `78.6 tok/s` live turn decode).
  - Measured `depth=6 + suffix_policy` outperformed `depth=8`, `depth=10`, and vanilla `oMLX 0.8.3` (`no m1_overlay`), while `fp8_kv_full` on `0.8.2` broke MTP acceptance (`0/510`) and is intentionally omitted.
- **Ornith 1.5 35B-A3B (`ornith-splash` port `18092`, `Splash` + `felkhayer/Ornith-1.5-35B-A3B-DFlash2-Splash`, `--kv-format int8 --verify-rows auto --expert-memory off --language-only --thinking-token-budget 2048`):**
  - Replaces legacy desktop `oMLX.app` (`61%` disk expert streaming) with zero disk streaming, reaching `93.9 overall tok/s` in micro-benchmarks and up to `142.1 tok/s` (`13.8 tok/cycle`) in live Phase 2 runs (`36m 19s`, `16/16` deliverables PASS vs incomplete baseline crash).
  - Ensure `~/.pi/agent/settings.json` includes `ornith-splash/ornith` under `compaction.modelOverrides` (`reserveTokens: 36864`, `keepRecentTokens: 12000`) so `pi` does not fall back to the `65536` global reserve and compact prematurely at `65K`.
- **Surogate 3.7 Flash (`surogate-splash` port `18091`, `Splash` + `incoai/Qwen3.6-35B-A3B-DFlash2`, `--kv-format int8 --verify-rows auto --cached-states int8 --expert-memory off --language-only --thinking-token-budget 2048`):**
  - Upgrading from `verify=all, kv=bf16` to `verify=auto, kv=int8` boosted micro-benchmark throughput by `+19.1%` (`29.9` → `35.6 overall tok/s`) and cut end-to-end 2-phase runtime by `-23.9%` (`29m 28s` → `22m 26s`) with zero compaction up to `80.6K` context.

### Running on an 8 GiB M1 Mac

A `35B-A3B` (`~20 GiB`) or dense `27B` model (`~17 GiB`) cannot stay resident on an **8 GiB M1 Mac** (macOS limits wired Metal allocations to `~5.3 GiB` out of `8 GiB` total). Even PrismML Ternary Bonsai 2.5 27B (`5.93` to `6.98 GiB` weights plus KV cache = `7` to `9 GiB`) exceeded an 8 GiB M1 and ran at `18.3 tok/s` on M1 Max.

Two practical setups do work well on an **8 GiB M1** with this exact harness (`pi-local --bare --preflight --trace`, `local-context-guard.ts`, `pi-verify-ui`):

- **Fast local 4B-to-8B MLX 4-bit agent:** `Qwen3-4B` / `Qwen3.5-4B` (`~2.5 GiB` weights, `25` to `35 tok/s`, comfortable `32K` KV headroom) is best for everyday file edits, Python/JS scripts, and Phase 1 / Phase 2 chunked tasks (`resolveLocalMaxTokens` `12,288` cap + `32K` `phase_handoff` keeps context tiny). `Qwen3-8B` / `Qwen3.5-9B` (`~4.5` to `5.2 GiB` weights) fits tightly if desktop apps are closed, `--kv-format int8` is used, and context stays `<= 16K` to `24K`.
- **Thin client to the `64 GiB` M1 Max:** Run `inkling-omlx` or `surogate-splash` on the M1 Max over LAN / Tailscale and point `baseUrl` in the 8 GiB M1's `~/.pi/agent/models.json` at the M1 Max endpoint (`http://<m1max-host>:18089/v1`) to get full `27B` / `35B-A3B` reasoning quality with near-zero RAM on the laptop.

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
  - Recommended coding-agent settings injected automatically for `surogate-local` by `local-omlx-meter.ts` when unset: `temperature: 0.65`, `top_p: 0.95`, `top_k: 20`, `preserve_thinking: true`, plus per-request `thinking_token_budget` scaled to Pi thinking levels (`minimal: 512`, `low: 1024`, `medium: 1536`, `high: 2048`, `xhigh/max: 4096`) paired with `--thinking-token-budget 2048` in **Splash** and **Rule 8 (Action bias)** in `prompts/local-lean-rules.md`. Keeping `high` (`2048` cap) for Phase 1 analysis and stepping down to `low` (`1024` cap) via `phase_handoff` for Phase 2 UI/script execution cuts thinking overhead without disabling reasoning on a `3B`-active MoE.

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
  - **Split GDN checkpoint eviction with `--auto-critic` on `--slots 1`:** Sending an out-of-band `--auto-critic` completion request to `inkling-omlx` (`--slots 1`) writes a separate critic sequence and invalidates the active session's Split GDN recurrent checkpoint, triggering ~`180 s` (`~50K`-token) cold re-prefills on post-critic turns. Keep `--auto-critic` for Splash models (`ornith-splash`, `surogate-splash`) or manual final `/critic` runs rather than mid-stream single-slot Inkling sessions.

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

---

## 8. Auto-Repairs, Syntax Hooks, and Real Browser Verification

An audit of `25` local Pi sessions (`734` tool calls, `66` errors) showed most recoverable local-model slowdowns come from repeated classes: runtime/script errors (`16`), local guard blocks (`12`), custom DOM stub test failures (`8`), `edit` `oldText` whitespace/escaping mismatches (`6`), Python/JS syntax errors caught late (`5`), missing GNU `timeout` on macOS (`1`), and stringified JSON `edit` arguments (`1`).

To eliminate those multi-turn retry loops automatically without mutating prior KV-cache history:

1. **Pre-validation auto-repairs in `local-context-guard.ts` (`message_end`):**
   - **Stringified `edits`, `edits[i]`, XML, and triple-quote recovery:** Parses stringified JSON passed to `edit.edits` or individual `edit.edits[i]` items (stripping stray markdown fences, trailing commas, and Python `"""..."""` triple-quoted values), extracts `<oldText>`/`<newText>` XML blocks stuffed inside an `"edit"` string field, and normalizes snake_case aliases (`old_text`/`old_string` → `oldText`).
   - **Safe `edit` whitespace cascade:** When literal `oldText` misses on disk, recovers unique CRLF/LF differences, unique contiguous trimmed-line blocks (only when match count `=== 1`, preserving disk indentation and shifting uniform `newText` indent), and unique outer-newline differences. Never guesses when `0` or `> 1` matches exist.
   - **macOS GNU `timeout` stripping:** Removes `timeout <duration>` prefixes on Darwin hosts lacking a `timeout` binary so valid verification commands do not exit `127`.
2. **Post-write/edit syntax hooks, runtime nudges, and shutdown cleanup (`tool_result` + `agent_end` + `session_shutdown`):**
   - **Immediate syntax check:** Runs `python3 -m py_compile` (`.py`) and `node --check` (`.js`/`.mjs`/`.cjs`) silently on every `write`/`edit` success, surfacing compiler stderr immediately on failure so broken syntax never compounds.
   - **`edit` anchor line hint & `agent-browser` nudges:** Reports the nearest matching line number (suggesting `write` for files `<= 150` lines) on both single-edit and `edits[N]` misses, redirects repeated stub failures toward real headless Chromium (`agent-browser`), nudges batching after `>= 6` consecutive single-assertion `agent-browser eval` calls, warns on `>= 60s` slow `bash` commands (`O(K^2)` / mega-cluster check), and closes leftover tracked `agent-browser` sessions on `session_shutdown`.
   - **Premature-stop auto-continue (`agent_end`):** Detects when a session stalls mid-task (`stop` / `length` with `0` tool calls and either empty visible text after thinking or a short `:` / `"Let me ..."` intent stub) when no `.pi-handoff.md` is staged, and injects up to `2` follow-up nudges automatically so multi-step builds finish completely.
   - **Per-model sampling guard (`local-omlx-meter.ts`):** Injects `temperature: 0.65`, `top_p: 0.95`, `top_k: 20` on both `surogate-local` and `omlx-local` when unset to prevent `temperature: 1.0` tool-JSON drift on desktop **oMLX** / **Splash**, while `pi-local` `stop_ornith()` falls back cleanly to `pkill -TERM -x oMLX` if AppleEvents quit times out.
3. **Static & runtime anti-pattern guards (`local-context-guard.ts` + `pi-preflight`):**
   - `pi-preflight` profiles workspace CSVs with zero row leakage and annotates low-cardinality columns (`distinct<=20` on `>= 100` rows) upfront so union-find logic never groups on statuses, types, or dates.
   - `checkPythonPerfHazards` inspects newly written or edited `.py` scripts immediately for unguarded `O(K^2)` `range(len(x))` pair loops before execution, while `inspectJsonClusterSkew` flags newly generated `.json` cluster outputs whose largest bucket exceeds `100` items (or `>= 50` on slow runs).
   - Paired with `pi-verify-ui --dom` (sub-`200 ms` in-process Node `happy-dom` inner loop with preinstalled `NODE_PATH`) + `pi-verify-ui` (single-shot real headless Chrome CDP final layout/error audit) and `local-goal-gate.ts` (`.pi-verify.json`), silent UI/clustering bugs fail cleanly in seconds without leaking `agent-browser` daemons or multi-turn browser polling. General filename-agnostic guardrails (`evaluateFileModifyChurn`, `extractCliCommandFamily`, `normalizeErrorClass`, and `resolveAdaptiveSplashThinkingBudget`) also catch per-file edit churn, repeated CLI probing, recurring non-consecutive error classes, and Splash thinking-cap starvation.

---

## 9. Engine & 2-Phase End-to-End Benchmark Results (M1 Max 64 GiB)

All v2 runs share tightened Splash thinking caps (`low: 640`, `medium: 1152`, `high: 2048`), `isWorkspaceScratchScript` throwaway guards, `repairMalformedJsonString` for stringified `edits`, `auto_critic` Split GDN bypass (`inkling-local`), `pi-verify-ui` + `pi-local --stop-all` Chromium/daemon cleanup (`AB_AFTER_VERIFY=0`, `CHROME_AFTER_VERIFY=0`), and models symlinked on `/Volumes/Extreme SSD` (`--max-cache-disk 0`, no persistent KV cache).

| Model | Baseline | v1 Run | v2 Run (`ed36f00` / `479b3ce`) | v3 Run (`c2f0afc` / `37cf807`) | v3 Highlights & Deliverables |
| --- | --- | --- | --- | --- | --- |
| Inkling 2 Mini | `25m 04s` (`1,504s`, `6` err) | `33m 24s` (`2,004s`, `90t`) | `28m 41s` (`1,721s`, `70t`, `0` edit err) | **`24m 51s`** (`P1 9m 34s` / `P2 15m 17s`, `71t`, `14.1%` reas) | **`-13.4%`** vs v2, `0` edit errors across `69` calls, `0` `agent-browser` calls, `1,405` groups (max `59`), exact `output/` filenames, `pi-verify-ui` Chrome CDP PASS (`0` errs) |
| Surogate 3.7 Flash | `29m 28s` (`1,768s`, `154t`) | `22m 26s` (`1,346s`, `142t`) | `77m 59s` (`r2`, `4,679s`, `318t`, critic loop) | **`31m 58s`** (`P1 19m 19s` / `P2 12m 39s`, `132t`, `23.4%` P2 reas) | **`-59.0%`** vs `r2` (`P2 -75.1%`), `3` P2 raw errs, `0` `agent-browser` calls, `358` calibrated groups (max `32`, streamed `532K` Interactions), Chrome CDP PASS (minor `updated_*.csv` naming diff) |
| Ornith 1.5 35B-A3B | `40m 32s` (`20m 45s` incomplete) | `36m 19s` (`2,179s`, `174t`) | `34m 51s` (`r5`, `2,091s`, `173t`, `39.8%` reas) | P1 `11m 49s` (`42t`) / P2 stopped at `43m 58s` | Strong P1 calibration (`603` groups, max `9`), `0` external URLs; P2 exposed two `32K`-token generation runaways (`19m 06s`) + `32` test-script micro-edits → fixed in v4 |

> **v3 → v4 learnings (`resolveLocalMaxTokens`, hard churn/CLI blocks, stale bundle detection):** Two `32,768`-token `stopReason: length` turns on Ornith burned `19m 06s` and dropped truncated `{}` tool arguments, while advisory `file_churn` / `cli_loop_hint` messages failed to stop `32` edits to `review_check.js`. Capping per-turn `max_tokens` at `12,288` (`PI_LOCAL_MAX_TURN_TOKENS`), upgrading verify-helper churn (`>= 14`) and CLI loops (`>= 14`) to hard blocks (resetting helper churn once app code is edited), and warning when `pi-verify-ui` inspects an HTML bundle older than its JS/CSS sources prevent that failure mode cleanly. (PrismML Ternary Bonsai 2.5 27B was also evaluated on M1 Max at `18.3 tok/s` decode and `7` to `9 GiB` RAM, timed out at `600s` on a UI microtest, and was not retained.)
