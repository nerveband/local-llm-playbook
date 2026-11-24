# local-llm-playbook

Personal playbook, extensions, copy-paste prompt templates, example Pi configurations, and a lean `pi-local` launcher for running local Apple Silicon LLMs (**Inkling 2 Mini**, **Ornith 1.5**, and **Surogate 3.7 Flash**) with **oMLX**, **Splash**, and **Pi**.

## Why `pi-local` exists

Global Pi setups often load cloud-oriented packages, skill catalogs, `codemode`, and extra tool definitions that can exceed `11,000` base tokens before your first message. On local Apple Silicon **oMLX** and **Splash** servers, every prefix-cache miss or compaction reset has to re-prefill that entire static prefix on-device.

`pi-local` handles everything from one command: shows an interactive model picker when launched in a terminal, stops any competing local model so Inkling, Ornith, and Surogate never collide inside `64 GiB` RAM, starts the chosen server if it is stopped, strips heavy cloud tools (`--no-mcp --no-skills --no-extensions --exclude-tools codemode`), loads accurate per-turn local speed telemetry (`local-omlx-meter.ts` supporting both oMLX `usage` and Splash `timings`), caps oversized tool outputs and blocks duplicate tool loops (`local-context-guard.ts`), and triggers `phase_handoff` + `/next-phase` around `32K` tokens for clean phase transitions.

### Measured baseline prompt reduction (Inkling 2 Mini on M1 Max)

| Mode | Turn-1 prompt tokens | Cold TTFT | Reduction vs global `pi` |
| --- | ---: | ---: | ---: |
| Global `pi` (12 packages + skills + codemode) | `11,328` | `~37 s` | baseline |
| `pi-local --subagents` | `6,786` | `21.96 s` | `-40.1%` |
| `pi-local` (keeps `AGENTS.md` + local rules + phase handoff) | `4,974` | `16.07 s` | `-56.1%` |
| `pi-local --bare` (`local-lean-rules.md` + `phase_handoff`) | `2,376` | `5.82 s` | `-79.0%` |
| `pi-local --bare --no-phase-tool` | `1,846` | `6.02 s` | `-83.7%` |

## Quickstart

Install the isolated local Pi extensions and link `pi-local` into `~/.local/bin`:

```zsh
./scripts/install-local-extensions.sh
```

Run `pi-local` (or `pi-local --bare`) in any project folder:

```zsh
pi-local --bare
```

You get an interactive menu with live status:

```text
pi-local: choose local model
  1) Inkling 2 Mini (128K, port 18089, oMLX + suffix_policy) [stopped]
  2) Ornith 1.5 35B-A3B (Splash DFlash2 + int8 KV, port 18092) [stopped]
  3) Surogate 3.7 Flash (Splash DFlash2 + int8 KV, port 18091) [stopped]
  4) Stop all local models and exit
```

Picking `1`, `2`, or `3` automatically quits any competing model server if active, starts the chosen model server (`inkling-omlx`, `ornith-splash`, or `surogate-splash`) if stopped, waits until ready, and launches Pi cleanly. Inside Pi, switch thinking anytime with `/thinking` (or `Shift+Tab`).

### Direct shortcut flags (skip picker)

```zsh
# Launch directly without showing the picker menu
pi-local --inkling
pi-local --inkling --bare --think low
pi-local --ornith
pi-local --ornith --no-think
pi-local --surogate
pi-local --surogate --bare
pi-local --inkling --subagents
pi-local --inkling --preflight --goal-gate --adaptive-think --trace

# Stop all local servers (ports 18089, 18091, 18092, 8000) to free all GPU RAM
pi-local --stop-all

# Skip auto stop/start or inspect resolved flags without launching
pi-local --surogate --no-autostart
pi-local --surogate --print-cmd
```

## Self-triggered phase handoffs and local safeguards

- **[`extensions/local-phase-handoff.ts`](extensions/local-phase-handoff.ts):** Registers an LLM-callable `phase_handoff` tool (with optional `next_thinking_level` per-phase switching via `pi.setThinkingLevel()`), a `32K`-token (or `72%`, whichever comes first, with a `message_end` usage fallback for **Splash**) speed notice on tool results, and a `/next-phase` command (supporting `--think <level>` overrides):
  - **Pause-for-review mode (`auto_continue: false`):** At a clean boundary, the model updates `notes.md`, writes `.pi-handoff.md` via `phase_handoff`, stops calling tools, and waits. Review deliverables and run `/next-phase` (with optional `--think low` and adjustment text) to launch the next phase in a brand-new session.
  - **Hands-free auto-continue mode (`auto_continue: true`):** When explicitly requested, calling `phase_handoff` with `auto_continue: true` causes `agent_end` to automatically invoke `/next-phase` (up to `3` automatic phase hops per run) and start the next phase in a fresh window without filling context.
- **[`extensions/local-omlx-meter.ts`](extensions/local-omlx-meter.ts):** Replaces `pi-token-speed` during `pi-local` sessions (`--legacy-speed` restores the global extension). Resets TTFT and a live `500 ms` per-turn stopwatch on every `turn_start`, labels `prefill` and `tool-buf` phases cleanly instead of displaying false low numbers during buffered tool calls, estimates multi-token MTP deltas live, snaps to authoritative **oMLX** `usage` or **Splash** `timings` at turn completion, skips `/api/status` polling on `surogate-local` (or `404`), and injects Surogate 3.7 / Qwen3.5-35B-A3B defaults (`temp 0.65`, `top_p 0.95`, `top_k 20`, `preserve_thinking: true`, and per-request `thinking_token_budget` scaled to Pi thinking levels) when unset.
- **[`extensions/local-context-guard.ts`](extensions/local-context-guard.ts):** Prefix-cache-safe auto-repair, post-edit syntax hook (`py_compile` / `node --check`), output diet, and loop guard (`--no-context-guard` disables). Repairs stringified `edits`/`edits[i]` JSON, unique CRLF/trimmed-line `edit` mismatches, and missing macOS GNU `timeout` prefixes in `message_end`, adds closest-line hints on `edit` misses and `agent-browser` headless Chromium nudges on repeated verify-script failures. Keeps head + tail lines when noisy `bash`/`grep`/`find`/`ls` outputs exceed `6,000` chars (`120` lines), explicit `sed -n` slices exceed `12,000` chars (`220` lines), or `read` exceeds `20,000` chars (`400` lines), exempts skill, reference, and instruction docs (`SKILL.md`, `notes.md`, `PROMPT.md`, `/skills*/`, `/reference/*.md`) up to `36,000` chars, spills the complete raw output to `/tmp/pi-local-tool-logs/...`, hashes tool inputs with `sha256` before heredoc checks to warn on the `2nd` identical call, escalate on repeated blocked heredocs, and block the `3rd` (even when `isError` is false), blocks `/tmp/*.py` scratch `write` calls, blocks `>= 800`-char `python3 -c` commands and `>= 5` consecutive inline `python3 -c` probes, allows `cat >> notes.md` heredocs up to `2,500` chars while hard-blocking other large `bash` heredocs (`>= 1,000` chars), warns on `400` to `999`-char heredocs, and separates `3+` consecutive inline `python3 -c` probes from `3+` consecutive shell `cat`/`head`/`tail`/`sed` reads, plus injects recovery hints on consecutive errors.

## Included files

- [`bin/pi-local`](bin/pi-local): Interactive picker + auto server lifecycle manager + lean Pi launcher (`pi-local --help`).
- [`bin/pi-preflight`](bin/pi-preflight): Zero-PII workspace schema profiler with bounded `distinct<=20` low-cardinality annotations for `--preflight`.
- [`bin/pi-outline`](bin/pi-outline): Fast AST outline extractor for Python and JS/TS files (`class`, `def`, top-level symbols).
- [`bin/pi-verify-ui`](bin/pi-verify-ui): Zero-daemon two-tier UI verification CLI supporting fast in-process Node `happy-dom` (`--dom`, `<200ms`) and single-shot real headless Chrome CDP (default, checking DOM counts, layout geometry / zero-size controls, console/page errors, custom `--eval-js`, and PNG screenshots).
- [`scripts/inkling-omlx`](scripts/inkling-omlx): Launches Inkling 2 Mini on `oMLX 0.8.2 + m1_overlay` (`depth=6 + suffix_policy + --m1-fast + --affine4`, port `18089`).
- [`scripts/ornith-splash`](scripts/ornith-splash): Launches Ornith 1.5 35B-A3B on `Splash + felkhayer DFlash2` (`--kv-format int8 --verify-rows auto --expert-memory off`, port `18092`).
- [`scripts/surogate-splash`](scripts/surogate-splash): Launches Surogate 3.7 Flash on `Splash + incoai DFlash2` (`--kv-format int8 --verify-rows auto --cached-states int8`, port `18091`).
- [`extensions/local-omlx-meter.ts`](extensions/local-omlx-meter.ts): Phase-aware per-turn timer, prefill/tool-buffering status, adaptive thinking scaling, and calibrated Inkling float `reasoning_effort` (`0.25`/`0.50`/`0.75`/`0.99`).
- [`extensions/local-context-guard.ts`](extensions/local-context-guard.ts): Prefix-cache-safe tool output trimmer (with disk spill), `sha256` loop guard, `ruff`/`oxlint` differential semantic lint, static `O(K^2)` loop hazard detector (`checkPythonPerfHazards`), runtime JSON cluster-skew detector (`inspectJsonClusterSkew`), and `edit`/heredoc/browser auto-repairs.
- [`extensions/local-goal-gate.ts`](extensions/local-goal-gate.ts): Automatic end-of-turn verification against `.pi-verify.json` (`--goal-gate`) before completion.
- [`extensions/local-critic.ts`](extensions/local-critic.ts): Fresh-context `/critic` command and `--auto-critic` end-of-task review with balanced workspace inventory.
- [`extensions/local-trace.ts`](extensions/local-trace.ts): Unified structured JSONL event tracer (`PI_LOCAL_TRACE_FILE` / `--trace`).
- [`extensions/local-phase-handoff.ts`](extensions/local-phase-handoff.ts): Self-triggered `phase_handoff` tool, `32K`-token speed notice, and `/next-phase` session switcher.
- [`configs/oxlintrc-local.json`](configs/oxlintrc-local.json): Fast `oxlint` ruleset with browser + node environments enabled for standalone UI/extension checks.
- [`configs/pi-models-local.example.json`](configs/pi-models-local.example.json): Local provider definitions (`inkling-local` on `18089`, `surogate-local` on `18091`, `ornith-splash` on `18092`, legacy `omlx-local` on `8000`).
- [`configs/pi-settings-local.example.json`](configs/pi-settings-local.example.json): Per-model thinking and compaction overrides for Inkling, Ornith Splash, and Surogate Splash (`reserveTokens: 36864`, `keepRecentTokens: 12000`).
- [`tests/harness.test.mjs`](tests/harness.test.mjs): Node unit & regression suite (`node --test tests/harness.test.mjs`).
- [`scripts/install-local-extensions.sh`](scripts/install-local-extensions.sh): Installs `pi-handoff` and `pi-subagents` into `~/.local/share/pi-local-extensions` and symlinks CLI helpers into `~/.local/bin`.
- [`prompts/local-lean-rules.md`](prompts/local-lean-rules.md): Short system prompt rules covering disk memory (`notes.md`), batched schema checks, `pi-verify-ui`, differential lint, blocking-vs-scoring separation, and `O(K)` union-find guards.
- [`BEST_PRACTICES.md`](BEST_PRACTICES.md): Engine A/B micro-benchmarks, Before-vs-After 3-model benchmarks, memory balance, KV prefix caching, and Split GDN `--slots 1` tradeoffs.
- [`PROMPTS.md`](PROMPTS.md): Copy-paste prompts for large tabular datasets, refactors, mid-session nudges, and phase transitions.

## Changelog

- `2026-11-24` (Two-tier `pi-verify-ui` via pure Node CDP + `happy-dom`, plus general harness guardrails):
  - **Zero-daemon UI verification across all 3 models:** Upgraded [`bin/pi-verify-ui`](bin/pi-verify-ui) to pure Node.js (`--dom` / `--fast` powered by `happy-dom` preinstalled via `NODE_PATH` in `bin/pi-local` for `<200ms` inner-loop checks with local `<script src>` inlining, plus default single-shot real headless Chrome CDP with process-group cleanup), eliminating `agent-browser` / `browser-use` daemon leaks and turn-by-turn UI polling across Inkling, Ornith, and Surogate.
  - **General filename-agnostic guardrails:** Added per-file `write+edit` churn detection (`evaluateFileModifyChurn`, nudging at `8, 12, 16`), session-wide repeated-CLI-family detection (`extractCliCommandFamily`), normalized non-consecutive identical-error strategy pivots (`normalizeErrorClass`), and automatic Splash thinking-budget escalation after `3` consecutive cap hits (`resolveAdaptiveSplashThinkingBudget` in [`extensions/local-omlx-meter.ts`](extensions/local-omlx-meter.ts), resetting cleanly once under budget).

- `2026-11-24` (v2 harness reliability, SSD storage migration, and full 3-model verification at `479b3ce`):
  - **Storage migration (no `--persistent-cache`):** Moved `lamq-models` (`8.8G`), `~/.omlx/models` (`21G`), and `~/.cache/huggingface` (`12G`) to `/Volumes/Extreme SSD` via symlinks (`103Gi` free on `/`, `2.9Ti` free on Extreme SSD) while keeping Splash `--max-cache-disk 0` and zero LoRA training.
  - **Harness v2 fixes:** Added `repairMalformedJsonString` in [`extensions/local-context-guard.ts`](extensions/local-context-guard.ts) (fixing raw inner quotes, dropped backslashes, stray brackets/parens, and invalid `\,` escapes inside stringified `edit.edits`), `isWorkspaceScratchScript` (blocking `_explore*.py`/`_diag*.py` workspace scripts), `shouldSkipAutoCriticForProvider` (skipping `--auto-critic` on `inkling-local` to prevent Split GDN re-prefills) and `isFalsePositiveInlineDataDefect` in [`extensions/local-critic.ts`](extensions/local-critic.ts), tightened Splash `resolveSplashThinkingBudget` (`minimal: 384`, `low: 640`, `medium: 1152`, `high: 2048`, `xhigh/max: 3072`) in [`extensions/local-omlx-meter.ts`](extensions/local-omlx-meter.ts), and TERM→KILL cleanup for `agent-browser-darwin-arm64` + `agent-browser-chrome-` orphans in [`bin/pi-verify-ui`](bin/pi-verify-ui) and [`bin/pi-local`](bin/pi-local).
  - **Verified `12/12` unit tests & 3-model v2 runs:** `"Edit request requires an edits array."` dropped to **`0`** across all 3 models (`0/319` Surogate calls, `0/68` Inkling calls, `0/180` Ornith calls). Ornith `ornith-opt-r5` finished in **`34m 51s`** (`2,091s`, `-14.0%` vs `40m 32s` baseline, `17` raw errors vs `50` in `r4`, `130.9` max tok/s, `pi-verify-ui` PASS); Inkling `inkling-opt-r4` finished in **`28m 41s`** (`1,721s`, `-14.1%` vs v1 `33m 24s`, `70` turns, `14.5%` reasoning, `9` raw errors / `0` edit errors, `auto_critic_skipped_gdn` fired, `pi-verify-ui` PASS); Surogate `surogate-opt-r2` finished in `77m 59s` (`4,679s`, `114` calibrated clusters max size `3`, `0` edits-array errors across `319` calls, `pi-verify-ui` `groupsLen: 114` PASS, exposing the inline-JSON critic false positive now filtered by `479b3ce`).

- `2026-11-24` (full Tier 1 to 3 engine + harness overhaul & 3-model verification):
  - **Engine upgrades:** Built `ornith-splash` (native `felkhayer/Ornith-1.5-35B-A3B-DFlash2-Splash` + `--kv-format int8 --verify-rows auto`, eliminating `61%` disk expert streaming and hitting up to `142.1 tok/s` decode); upgraded `surogate-splash` to `--verify-rows auto --kv-format int8` (`+19.1%` micro-benchmark throughput and `-23.9%` faster end-to-end run with zero compaction past `80K`); upgraded `inkling-omlx` to `oMLX 0.8.2 + m1_overlay` (`depth=6 + suffix_policy + --m1-fast + --affine4`) with calibrated float `reasoning_effort` (`0.25`/`0.50`/`0.75`/`0.99`). Audited `hackafterdark/phosphor`, `dangxingyu/megakernel-zoo`, and `qwegnai/qwegn` v0.36.0 (`kernel_std.metallib` Apple7 support confirmed; requires `.qwg` pack).
  - **Harness & verification upgrades:** Added `pi-preflight` (with zero-PII bounded `distinct<=20` low-cardinality column annotations), `pi-outline`, `pi-verify-ui`, `local-goal-gate.ts`, `local-critic.ts` (async lifecycle fix, balanced inventory + head/tail snippets), `local-trace.ts`, differential `ruff`/`oxlint` checks via `configs/oxlintrc-local.json`, static `O(K^2)` Python loop hazard detection (`checkPythonPerfHazards`), runtime JSON cluster-skew detection (`inspectJsonClusterSkew`), `--adaptive-think`, and `pi-hashline-edit@0.8.4`. Verified `9/9` unit tests passing and full end-to-end 3-model completions across Ornith (`36m 19s`, `16/16` PASS), Surogate (`22m 26s`, `-23.9%` vs baseline, `16/16` deliverables PASS), and Inkling (`7m 41s` P1 = `-44.2%`, `20m 30s` pre-critic / `33m 24s` post-critic, PASS).

- `2026-11-23` (post-benchmark harness hardening): Added premature/empty-stop auto-continue (`agent_end`, max `2` retries when no `.pi-handoff.md` is staged), XML `<oldText>` and Python `"""..."""` stringified `edit` repairs, multi-edit `edits[N]` closest-line hints, `6+` micro `agent-browser eval` batching nudge, `session_shutdown` leftover `agent-browser` session cleanup, `>= 60s` slow-`bash` `O(K^2)`/mega-cluster hint, `omlx-local` `temp 0.65` / `top_p 0.95` / `top_k 20` injection in `local-omlx-meter.ts`, `pkill -TERM -x oMLX` fallback in `bin/pi-local` `stop_ornith()`, and clustering guard Rule `11` in `prompts/local-lean-rules.md`.
- `2026-11-23` (harness upgrade): Added `message_end` auto-repairs (stringified `edit.edits` and `edits[i]` JSON parsing, snake_case edit field normalization, unique CRLF/trimmed-line whitespace block matching, and macOS GNU `timeout` stripping), post-`write`/`edit` automatic `py_compile` / `node --check` syntax checks, `edit` closest-line hints, repeated verify-script `agent-browser` headless Chromium nudges + Rules `9` and `10` in `prompts/local-lean-rules.md`, and per-request **Splash** `thinking_token_budget` scaling (`minimal: 512`, `low: 1024`, `medium: 1536`, `high: 2048`, `xhigh: 4096`) in `local-omlx-meter.ts` and `surogate-local` `thinkingLevelMap`.
- `2026-11-23`: Removed deprecated `pi-continue` completely from `pi-local` and `install-local-extensions.sh` after catching a `69K`/`65.5K` `Operation aborted` / `Compaction cancelled` crash during long Phase 2 local runs; added **Surogate 3.7 Flash** (Qwen3.5-35B-A3B-Base) coding-agent defaults (`temperature: 0.65`, `top_p: 0.95`, `top_k: 20`, `preserve_thinking: true`) and skipped `/api/status` `404` polling in `local-omlx-meter.ts`; raised Surogate `reserveTokens` (`24576` -> `36864`), added Action-Bias Rule `8` in `local-lean-rules.md`, added `message_end` context-token fallback in `local-phase-handoff.ts` for **Splash**, and hard-blocked `/tmp/*.py` scratch writes, `>= 800`-char inline `python3 -c` scripts, and `>= 5` consecutive inline `python3 -c` probe streaks in `local-context-guard.ts`; updated Inkling sampling defaults to `--default-temp 0.6 --top-p 0.95 --repetition-penalty 1.0` (`presence_penalty: 0.0`) based on Qwen 3.8 27B and Inkling 2 Mini thinking-mode findings; added Adversarial Self-Check rule (`prompts/local-lean-rules.md`); raised Inkling `maxTokens` (`16384` -> `32768`) and `reserveTokens` (`24576` -> `36864`); added self-adaptive per-phase thinking (`next_thinking_level` in `phase_handoff` + `/next-phase --think <level>` via `pi.setThinkingLevel()`).

- `2026-11-22`: Added Surogate 3.7 Flash (`--surogate`, `surogate-local/surogate` on port `18091`, managed by `surogate-splash` with Splash `1.7.0-m1` + DFlash2 + `bf16` KV/state + `2048` thinking cap + `128K` context), added `--thinking-token-budget 2048` default for Ornith in `splash-no-disk`, added 3-way mutual exclusion to `pi-local`, and added Splash `chunk.timings` extraction to `local-omlx-meter.ts`.

- `2026-11-21`: Added `local-omlx-meter.ts` (accurate per-turn stopwatch, prefill/tool-buffering indicators, and exact oMLX telemetry), `local-context-guard.ts` (prefix-cache-safe tool output trimming + disk log spill + tool-failure recovery hints), lowered `phase_handoff` threshold to `40K` tokens, and tightened `local-lean-rules.md` stdout limit to `20` lines.

- `2026-11-21`: Added interactive model picker and automatic stop/start server lifecycle management to `pi-local` (Inkling, Ornith thinking ON/OFF, `--stop-all`, `--inkling`, `--pick`, `--no-autostart`).
- `2026-11-21`: Added custom `extensions/local-phase-handoff.ts` (`phase_handoff` tool + `/next-phase` auto/manual handoffs + `72%` context notice), full Ornith support (`--ornith`, `--no-think`, `--print-cmd`, compaction override `reserveTokens: 131072`), and measured `2,376`-token `pi-local --bare` verification.
- `2026-11-21`: Initial playbook, `pi-local` lean launcher, isolated local extensions (`pi-handoff`, `pi-continue`, `pi-subagents`), and `128K` + `12GB` hot cache Inkling tuning.
