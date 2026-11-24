# Local LLM Best Practices (Apple Silicon + oMLX + Pi)

Living field guide for keeping local coding and data-analysis sessions fast, accurate, and free of mid-turn truncation while leaving enough unified RAM and GPU headroom for browsers and desktop work.

---

## 1. Hardware and Memory Budget (64 GiB M1 Max)

- **Inkling 2 Mini (`128K` context, `--slots 1`, `--hot-cache-max-size 6GB`, `--default-temp 0.2` on port `18089`):**
  - Active model + `64K` KV peak measured `24.39 GB` GPU RAM (`31,712` KV tokens add only `+0.91 GB` across `8` full-attention layers with `1024` sliding-window attention).
  - Use `--default-temp 0.2` instead of `0.0`: pure greedy decoding (`0.0`) on local MoE models can lock into repeating identical tool calls or identical thinking traces, whereas `0.2` keeps code generation accurate while breaking repetition loops.
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
- At `32,000` tokens (or `72%` of the window, whichever comes first), a `tool_result` notice whispers once to the model to wrap up `notes.md` and call `phase_handoff` at the next milestone before long-context decode slows down.
- `extensions/local-context-guard.ts` trims oversized noisy `bash`/`grep`/`find`/`ls` (`>6,000` chars / `120` lines), explicit `sed -n` line-range slices (`>12,000` chars / `220` lines), and `read` (`>20,000` chars / `400` lines) outputs at insertion time while keeping skill/reference/instruction docs (`SKILL.md`, `notes.md`, `PROMPT.md`, `/skills*/`, `/reference/*.md`) intact up to `36,000` chars and spilling trimmed logs to `/tmp/pi-local-tool-logs` so context grows slowly without mutating prior history. It also hashes full tool-call inputs with `sha256` to catch non-error loops (warns on the `2nd` identical call in a row, blocks the `3rd` identical call via `tool_call`), and nudges succeeding large multi-line `bash` heredocs (`>= 400` chars) back to `write`/`edit`.
- **Two modes controlled by `auto_continue`:**
  - `auto_continue: false` (default): Model writes `.pi-handoff.md`, stops calling tools, and waits so you can inspect deliverables and run `/next-phase` when ready.
  - `auto_continue: true`: When you want hands-free execution across phases, `agent_end` automatically runs `/next-phase` (`ctx.newSession`), opening a fresh clean window with `.pi-handoff.md` as its starting prompt (capped at `3` auto-hops per run for loop safety).

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
4. **Reset sessions around `32K` tokens.** Lower thinking to `low` or `off` (`Shift+Tab`) during mechanical code-writing phases for peak `~61` to `65 tok/s`, and let `phase_handoff` + `/next-phase` keep phases fast in fresh sessions.
