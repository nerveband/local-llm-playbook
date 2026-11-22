# Local LLM Best Practices (Apple Silicon + oMLX + Pi)

Living field guide for keeping local coding and data-analysis sessions fast, accurate, and free of mid-turn truncation while leaving enough unified RAM and GPU headroom for browsers and desktop work.

---

## 1. Hardware and Memory Budget (64 GiB M1 Max)

- **Inkling 2 Mini (`128K` context, `--slots 1`, `--hot-cache-max-size 12GB` on port `18089`):**
  - Active model + `64K` KV peak measured `24.39 GB` GPU RAM (`31,712` KV tokens add only `+0.91 GB` across `8` full-attention layers with `1024` sliding-window attention).
  - Raising `--context` to `131072` (`128K`) adds roughly `1.8 GB` at full context (`~26.2 GB` active), plus up to `12 GB` hot KV prefix cache (`~38 GB` upper ceiling).
  - Leaves roughly `26 GiB` free for macOS, web browsers, and editors with low swap pressure.
- **Ornith 1.5 35B-A3B (`38 GB` resident budget via `splash-1.7.0-m1` + desktop **oMLX** on port `8000`):**
  - Stop Inkling (`inkling-omlx stop`) before opening **oMLX** for Ornith, and unload Ornith before heavy Inkling sessions.
  - Running **either Inkling or Ornith one at a time** keeps browser tabs and desktop apps responsive with zero memory thrashing.
  - `pi-local` automatically checks ports `18089` and `8000` at startup and prints a warning if both local servers are running at the same time.
- **Keep `--slots 1`:** Doubling slots splits memory bandwidth and allocates extra concurrent KV state, slowing single-user interactive speed.

---

## 2. Compaction and Thinking Budget Math

Mid-turn truncation (`Response was truncated before completion` / `finish_reason=length`) happens when `compaction.reserveTokens` is smaller than `maxTokens`:

- **Inkling (`contextWindow: 131072`, `maxTokens: 16384`):**
  - `reserveTokens: 24576` triggers clean compaction between tool calls around `106,496` tokens (`81.25%`), guaranteeing a full `16384`-token output runway on every turn.
  - `keepRecentTokens: 12000` keeps the post-compaction slice tight so cold prefill finishes fast.
  - `modelThinkingLevels["inkling-local/inkling"] = "medium"` avoids burning 3,000+ thinking tokens on simple file reads. Override with `pi-local --think low` or `--no-think` for routine extraction loops.
- **Ornith (`contextWindow: 262144`, `maxTokens: 32768`):**
  - `reserveTokens: 131072` compacts cleanly halfway (`131,072` tokens) with `32,768` output headroom intact, keeping decode near peak speed and KV RAM bounded.
  - `modelThinkingLevels["omlx-local/Ornith-1.5-35B-A3B-Abliterated-MLX-4bit"] = "high"` keeps thinking on by default; pass `pi-local --ornith --no-think` when you want fast direct code or prose generation.

---

## 3. Self-Triggered Phase Boundaries (`phase_handoff` + `/next-phase`)

Instead of letting a single long run hit emergency compaction, let the model switch phases cleanly on disk:

- `extensions/local-phase-handoff.ts` gives the model a `phase_handoff` tool that writes `.pi-handoff.md` with the completed summary, key files on disk (`notes.md`, scripts, JSON outputs), and the exact next-phase task.
- At `40,000` tokens (or `72%` of the window, whichever comes first), a `tool_result` notice whispers once to the model to wrap up `notes.md` and call `phase_handoff` at the next milestone before long-context decode slows down.
- `extensions/local-context-guard.ts` trims oversized noisy `bash`/`grep`/`find`/`ls` (`>6,000` chars / `120` lines) and `read` (`>20,000` chars / `400` lines) outputs at insertion time while keeping skill/reference/instruction docs (`SKILL.md`, `notes.md`, `PROMPT.md`, `/skills*/`, `/reference/*.md`) intact up to `36,000` chars and spilling trimmed logs to `/tmp/pi-local-tool-logs` so context grows slowly without mutating prior history.
- **Two modes controlled by `auto_continue`:**
  - `auto_continue: false` (default): Model writes `.pi-handoff.md`, stops calling tools, and waits so you can inspect deliverables and run `/next-phase` when ready.
  - `auto_continue: true`: When you want hands-free execution across phases, `agent_end` automatically runs `/next-phase` (`ctx.newSession`), opening a fresh clean window with `.pi-handoff.md` as its starting prompt (capped at `3` auto-hops per run for loop safety).

---

## 4. Protecting the oMLX Prefix Cache

Hybrid architectures using sliding-window attention and recurrent GDN layers require exact prefix matching from token `0`:

- **Keep chat history append-only during a task.** Avoid extensions that rewrite, edit, or delete earlier assistant/tool messages mid-session, because mutating earlier tokens forces a `1` to `2` minute cold re-prefill in **oMLX**.
- **Keep static system prompts small and stable.** Stripping global MCPs, skills, `codemode`, and cloud tools via `pi-local` drops turn-1 base tokens from `11,328` down to `4,974` (`pi-local`), `2,376` (`pi-local --bare`), or `1,846` (`pi-local --bare --no-phase-tool`).
- **Avoid `/reload` mid-session.** Changing tools or prompts mid-run shifts the prefix and invalidates cached KV blocks.

---

## 5. Plugin and Harness Compatibility Matrix

| Tool / Extension | Role on Local oMLX | Prefix-Cache Safe? | Recommendation |
| --- | --- | --- | --- |
| `local-phase-handoff.ts` | Self-triggered `phase_handoff` tool + `/next-phase` + `40K` notice | Yes (appends once or starts fresh session) | **Enabled by default in `pi-local`** |
| `local-context-guard.ts` | Insertion-time head+tail output cap + `/tmp` log spill + failure hints | Yes (edits before insertion, never mutates prior turns) | **Enabled by default in `pi-local`** |
| `local-omlx-meter.ts` | Per-turn timer + prefill/tool-buffering status + oMLX server stats | Yes | **Enabled by default in `pi-local`** |
| `pi-handoff` | Manual `/handoff` command into a new session | Yes (fresh session) | **Enabled in `pi-local`** |
| `pi-continue` | Compacts safely before overflow using a disk ledger | Yes (native cut point) | **Safety net (pass `--no-continue` to skip)** |
| `pi-subagents` | Isolates noisy exploration into child sessions | Yes (isolated runs) | **Use sequentially (`pi-local --subagents`)** |
| `pi-tool-repair` / `@erichll/pi-statusline` | Repairs malformed tool JSON and renders footer status | Yes | **Keep enabled in `pi-local`** |
| `pi-token-speed` (legacy) | Client chunk counter; undercounts MTP bursts and buffers | Yes | Replaced by `local-omlx-meter.ts` (`--legacy-speed`) |
| Mid-history pruners (`pi-smart-compact`, `pi-context-kit`, `cprune`) | Deletes old tool outputs from earlier turns | No (breaks prefix from token 0) | Best for cloud APIs, skip for hybrid local **oMLX** models |
| `rtk` (CLI output compressor) | Compresses verbose shell stdout before entering history | Yes | Good companion for heavy build/test logs |

Note: `pi-continue` emits an npm deprecation notice as of `0.9.3`, so pass `--no-continue` to `pi-local` if you prefer `local-phase-handoff.ts` + `/handoff` alone.

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
3. **Write `.py` and `.html` files with `write`/`edit` tools.** Avoid bash heredocs (`<<EOF`), which trigger quoting bugs and waste generation tokens.
4. **Reset sessions around `40K` tokens.** Lower thinking to `low` or `off` (`Shift+Tab`) during mechanical code-writing phases for peak `~61` to `65 tok/s`, and let `phase_handoff` + `/next-phase` keep phases fast in fresh sessions.
