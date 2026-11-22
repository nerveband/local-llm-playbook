# local-llm-playbook

Personal playbook, copy-paste prompt templates, example Pi configurations, and a lean `pi-local` launcher for running local Apple Silicon LLMs with **oMLX** and **Pi**.

## Why `pi-local` exists

Global Pi setups often load cloud-oriented packages, skill catalogs, `codemode`, and extra tool definitions that can exceed `11,000` base tokens before your first message. On local Apple Silicon **oMLX** servers, every prefix-cache miss or compaction reset has to re-prefill that entire static prefix on-device.

`pi-local` runs `pi` with `--no-mcp`, `--no-skills`, `--no-extensions`, and `--exclude-tools codemode`, then loads only local-friendly extensions from an isolated directory (`~/.local/share/pi-local-extensions`) without touching your cloud `pi` config.

### Measured baseline prompt reduction (Inkling 2 Mini on M1 Max)

| Mode | Turn-1 prompt tokens | Cold TTFT | Reduction vs global `pi` |
| --- | ---: | ---: | ---: |
| Global `pi` (12 packages + skills + codemode) | `11,328` | `~37 s` | baseline |
| `pi-local --subagents` | `6,786` | `21.96 s` | `-40.1%` |
| `pi-local` (keeps `AGENTS.md` + local rules + handoff/continue) | `4,974` | `16.07 s` | `-56.1%` |
| `pi-local --bare` (skips `AGENTS.md` / `CLAUDE.md` too) | `1,846` | `6.02 s` | `-83.7%` |

## Quickstart

Install the isolated local Pi extensions and link `pi-local` into `~/.local/bin`:

```zsh
./scripts/install-local-extensions.sh
```

Launch in any project directory:

```zsh
# Default: Inkling 2 Mini (128K context, medium thinking, lean rules, pi-handoff, pi-continue)
pi-local

# Smallest possible cold prefill (~1,846 tokens, skips global AGENTS.md/CLAUDE.md)
pi-local --bare

# Enable sequential isolated subagent delegation
pi-local --subagents

# Override thinking level for lighter CSV/script exploration
pi-local --think low

# Launch on Ornith 1.5 35B-A3B (oMLX desktop port 8000)
pi-local --ornith
```

## Included files

- [`bin/pi-local`](bin/pi-local): Lean launcher script (`pi-local --help` for all options).
- [`scripts/install-local-extensions.sh`](scripts/install-local-extensions.sh): Installs `pi-handoff`, `pi-continue`, and `pi-subagents` into `~/.local/share/pi-local-extensions` and symlinks `pi-local`.
- [`prompts/local-lean-rules.md`](prompts/local-lean-rules.md): Short system prompt rules for disk-backed state (`notes.md`), schema-first inspection, `.py` scripts, and capped stdout.
- [`configs/pi-models-local.example.json`](configs/pi-models-local.example.json): Local provider definitions (`131072` context, `16384` max output, `thinkingLevelMap`, `compat`).
- [`configs/pi-settings-local.example.json`](configs/pi-settings-local.example.json): Per-model thinking level (`medium`) and safe compaction headroom (`reserveTokens: 24576`, `keepRecentTokens: 12000`).
- [`BEST_PRACTICES.md`](BEST_PRACTICES.md): Apple Silicon memory balance, KV prefix caching, compaction math, and subagent concurrency guidelines.
- [`PROMPTS.md`](PROMPTS.md): Copy-paste prompts for large tabular datasets, refactors, mid-session nudges, and `/handoff` transitions.

## Changelog

- `2026-11-21`: Initial playbook, `pi-local` lean launcher, isolated local extensions (`pi-handoff`, `pi-continue`, `pi-subagents`), `128K` + `12GB` hot cache Inkling tuning, and measured `pi-local` prompt benchmarks.
