# local-llm-playbook

Personal playbook, extensions, copy-paste prompt templates, example Pi configurations, and a lean `pi-local` launcher for running local Apple Silicon LLMs with **oMLX** and **Pi**.

## Why `pi-local` exists

Global Pi setups often load cloud-oriented packages, skill catalogs, `codemode`, and extra tool definitions that can exceed `11,000` base tokens before your first message. On local Apple Silicon **oMLX** servers, every prefix-cache miss or compaction reset has to re-prefill that entire static prefix on-device.

`pi-local` handles everything from one command: shows an interactive model picker when launched in a terminal, stops any competing local model so Inkling and Ornith never collide inside `64 GiB` RAM, starts the chosen server if it is stopped, strips heavy cloud tools (`--no-mcp --no-skills --no-extensions --exclude-tools codemode`), and loads `phase_handoff` + `/next-phase` for clean phase transitions.

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
  1) Inkling 2 Mini (128K, medium thinking, port 18089) [running]
  2) Ornith 1.5 35B-A3B (thinking ON, port 8000)        [stopped]
  3) Ornith 1.5 35B-A3B (thinking OFF, port 8000)       [stopped]
  4) Stop all local models and exit
```

Picking any option automatically quits the competing model server if active, starts the chosen model server if stopped, waits until ready, and launches Pi cleanly.

### Direct shortcut flags (skip picker)

```zsh
# Launch directly without showing the picker menu
pi-local --inkling
pi-local --inkling --bare --think low
pi-local --ornith
pi-local --ornith --no-think
pi-local --inkling --subagents

# Stop both local servers to free all GPU RAM
pi-local --stop-all

# Skip auto stop/start or inspect resolved flags without launching
pi-local --ornith --no-autostart
pi-local --ornith --print-cmd
```

## Self-triggered phase handoffs (`phase_handoff` + `/next-phase`)

`extensions/local-phase-handoff.ts` registers an LLM-callable `phase_handoff` tool, a `72%` context usage notice on tool results, and a `/next-phase` command:

- **Pause-for-review mode (`auto_continue: false`):** At a clean boundary, the model updates `notes.md`, writes `.pi-handoff.md` via `phase_handoff`, stops calling tools, and waits. Review deliverables and run `/next-phase` (with optional adjustment text) to launch Phase 2 in a brand-new session.
- **Hands-free auto-continue mode (`auto_continue: true`):** When explicitly requested, calling `phase_handoff` with `auto_continue: true` causes `agent_end` to automatically invoke `/next-phase` (up to `3` automatic phase hops per run) and start the next phase in a fresh window without filling context.

## Included files

- [`bin/pi-local`](bin/pi-local): Interactive picker + auto server lifecycle manager + lean Pi launcher (`pi-local --help`).
- [`extensions/local-phase-handoff.ts`](extensions/local-phase-handoff.ts): Self-triggered `phase_handoff` tool, `72%` context notice, and `/next-phase` session switcher.
- [`scripts/install-local-extensions.sh`](scripts/install-local-extensions.sh): Installs `pi-handoff`, `pi-continue`, and `pi-subagents` into `~/.local/share/pi-local-extensions` and symlinks `pi-local`.
- [`prompts/local-lean-rules.md`](prompts/local-lean-rules.md): Short system prompt rules for disk-backed state (`notes.md`), schema-first inspection, `.py` scripts, capped stdout, and `phase_handoff`.
- [`configs/pi-models-local.example.json`](configs/pi-models-local.example.json): Local provider definitions (`131072` context, `16384` max output, `thinkingLevelMap`, `compat`).
- [`configs/pi-settings-local.example.json`](configs/pi-settings-local.example.json): Per-model thinking and compaction overrides for both Inkling (`medium`, `reserveTokens: 24576`) and Ornith (`high`, `reserveTokens: 131072`).
- [`BEST_PRACTICES.md`](BEST_PRACTICES.md): Apple Silicon memory balance, KV prefix caching, compaction math, Ornith workflow, and subagent concurrency guidelines.
- [`PROMPTS.md`](PROMPTS.md): Copy-paste prompts for large tabular datasets, refactors, mid-session nudges, and phase transitions.

## Changelog

- `2026-11-21`: Added interactive model picker and automatic stop/start server lifecycle management to `pi-local` (Inkling, Ornith thinking ON/OFF, `--stop-all`, `--inkling`, `--pick`, `--no-autostart`).
- `2026-11-21`: Added custom `extensions/local-phase-handoff.ts` (`phase_handoff` tool + `/next-phase` auto/manual handoffs + `72%` context notice), full Ornith support (`--ornith`, `--no-think`, `--print-cmd`, compaction override `reserveTokens: 131072`), and measured `2,376`-token `pi-local --bare` verification.
- `2026-11-21`: Initial playbook, `pi-local` lean launcher, isolated local extensions (`pi-handoff`, `pi-continue`, `pi-subagents`), and `128K` + `12GB` hot cache Inkling tuning.
