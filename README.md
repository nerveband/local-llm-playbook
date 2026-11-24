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
  1) Inkling 2 Mini (128K, port 18089)   [running]
  2) Ornith 1.5 35B-A3B (port 8000)      [stopped]
  3) Surogate 3.7 Flash (128K, port 18091) [stopped]
  4) Stop all local models and exit
```

Picking `1`, `2`, or `3` automatically quits any competing model server if active, starts the chosen model server (`inkling-omlx`, `oMLX.app`, or `surogate-splash`) if stopped, waits until ready, and launches Pi cleanly. Inside Pi, switch thinking anytime with `/thinking` (or `Shift+Tab`).

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

# Stop all local servers (ports 18089, 18091, 8000) to free all GPU RAM
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
- [`extensions/local-omlx-meter.ts`](extensions/local-omlx-meter.ts): Phase-aware per-turn timer and **oMLX** telemetry speedometer.
- [`extensions/local-context-guard.ts`](extensions/local-context-guard.ts): Prefix-cache-safe tool output trimmer (with disk spill), `sha256` exact-call loop guard, and heredoc/failure hints.
- [`extensions/local-phase-handoff.ts`](extensions/local-phase-handoff.ts): Self-triggered `phase_handoff` tool, `32K`-token speed notice, and `/next-phase` session switcher.
- [`scripts/install-local-extensions.sh`](scripts/install-local-extensions.sh): Installs `pi-handoff` and `pi-subagents` into `~/.local/share/pi-local-extensions` and symlinks `pi-local`.
- [`prompts/local-lean-rules.md`](prompts/local-lean-rules.md): Short system prompt rules for disk-backed state (`notes.md`), batched read-only schema checks, `read`/`edit` over `bash cat`/heredocs, direct `~/.config/skillshare/skills-shared/` path loading, `20`-line stdout cap, `phase_handoff`, and Adversarial Self-Check before finishing.
- [`configs/pi-models-local.example.json`](configs/pi-models-local.example.json): Local provider definitions (`inkling-local` on `18089`, `omlx-local` on `8000`, `surogate-local` on `18091` with `131072` context and `32768` max output).
- [`configs/pi-settings-local.example.json`](configs/pi-settings-local.example.json): Per-model thinking and compaction overrides for Inkling (`medium`, `reserveTokens: 36864` with `maxTokens: 32768`), Ornith (`high`, `reserveTokens: 131072`), and Surogate (`high`, `reserveTokens: 36864` with `maxTokens: 32768`).
- [`BEST_PRACTICES.md`](BEST_PRACTICES.md): Apple Silicon memory balance, KV prefix caching, compaction math, Ornith workflow, and subagent concurrency guidelines.
- [`PROMPTS.md`](PROMPTS.md): Copy-paste prompts for large tabular datasets, refactors, mid-session nudges, and phase transitions.

## Changelog

- `2026-11-23` (post-benchmark harness hardening): Added premature/empty-stop auto-continue (`agent_end`, max `2` retries when no `.pi-handoff.md` is staged), XML `<oldText>` and Python `"""..."""` stringified `edit` repairs, multi-edit `edits[N]` closest-line hints, `6+` micro `agent-browser eval` batching nudge, `session_shutdown` leftover `agent-browser` session cleanup, `>= 60s` slow-`bash` `O(K^2)`/mega-cluster hint, `omlx-local` `temp 0.65` / `top_p 0.95` / `top_k 20` injection in `local-omlx-meter.ts`, `pkill -TERM -x oMLX` fallback in `bin/pi-local` `stop_ornith()`, and clustering guard Rule `11` in `prompts/local-lean-rules.md`.
- `2026-11-23` (harness upgrade): Added `message_end` auto-repairs (stringified `edit.edits` and `edits[i]` JSON parsing, snake_case edit field normalization, unique CRLF/trimmed-line whitespace block matching, and macOS GNU `timeout` stripping), post-`write`/`edit` automatic `py_compile` / `node --check` syntax checks, `edit` closest-line hints, repeated verify-script `agent-browser` headless Chromium nudges + Rules `9` and `10` in `prompts/local-lean-rules.md`, and per-request **Splash** `thinking_token_budget` scaling (`minimal: 512`, `low: 1024`, `medium: 1536`, `high: 2048`, `xhigh: 4096`) in `local-omlx-meter.ts` and `surogate-local` `thinkingLevelMap`.
- `2026-11-23`: Removed deprecated `pi-continue` completely from `pi-local` and `install-local-extensions.sh` after catching a `69K`/`65.5K` `Operation aborted` / `Compaction cancelled` crash during long Phase 2 local runs; added **Surogate 3.7 Flash** (Qwen3.5-35B-A3B-Base) coding-agent defaults (`temperature: 0.65`, `top_p: 0.95`, `top_k: 20`, `preserve_thinking: true`) and skipped `/api/status` `404` polling in `local-omlx-meter.ts`; raised Surogate `reserveTokens` (`24576` -> `36864`), added Action-Bias Rule `8` in `local-lean-rules.md`, added `message_end` context-token fallback in `local-phase-handoff.ts` for **Splash**, and hard-blocked `/tmp/*.py` scratch writes, `>= 800`-char inline `python3 -c` scripts, and `>= 5` consecutive inline `python3 -c` probe streaks in `local-context-guard.ts`; updated Inkling sampling defaults to `--default-temp 0.6 --top-p 0.95 --repetition-penalty 1.0` (`presence_penalty: 0.0`) based on Qwen 3.8 27B and Inkling 2 Mini thinking-mode findings; added Adversarial Self-Check rule (`prompts/local-lean-rules.md`); raised Inkling `maxTokens` (`16384` -> `32768`) and `reserveTokens` (`24576` -> `36864`); added self-adaptive per-phase thinking (`next_thinking_level` in `phase_handoff` + `/next-phase --think <level>` via `pi.setThinkingLevel()`).

- `2026-11-22`: Added Surogate 3.7 Flash (`--surogate`, `surogate-local/surogate` on port `18091`, managed by `surogate-splash` with Splash `1.7.0-m1` + DFlash2 + `bf16` KV/state + `2048` thinking cap + `128K` context), added `--thinking-token-budget 2048` default for Ornith in `splash-no-disk`, added 3-way mutual exclusion to `pi-local`, and added Splash `chunk.timings` extraction to `local-omlx-meter.ts`.

- `2026-11-21`: Added `local-omlx-meter.ts` (accurate per-turn stopwatch, prefill/tool-buffering indicators, and exact oMLX telemetry), `local-context-guard.ts` (prefix-cache-safe tool output trimming + disk log spill + tool-failure recovery hints), lowered `phase_handoff` threshold to `40K` tokens, and tightened `local-lean-rules.md` stdout limit to `20` lines.

- `2026-11-21`: Added interactive model picker and automatic stop/start server lifecycle management to `pi-local` (Inkling, Ornith thinking ON/OFF, `--stop-all`, `--inkling`, `--pick`, `--no-autostart`).
- `2026-11-21`: Added custom `extensions/local-phase-handoff.ts` (`phase_handoff` tool + `/next-phase` auto/manual handoffs + `72%` context notice), full Ornith support (`--ornith`, `--no-think`, `--print-cmd`, compaction override `reserveTokens: 131072`), and measured `2,376`-token `pi-local --bare` verification.
- `2026-11-21`: Initial playbook, `pi-local` lean launcher, isolated local extensions (`pi-handoff`, `pi-continue`, `pi-subagents`), and `128K` + `12GB` hot cache Inkling tuning.
