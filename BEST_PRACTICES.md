# Local LLM Best Practices (Apple Silicon + oMLX + Pi)

Living field guide for keeping local coding and data-analysis sessions fast, accurate, and free of mid-turn truncation while leaving enough unified RAM and GPU headroom for browsers and desktop work.

---

## 1. Hardware and Memory Budget (64 GiB M1 Max)

- **Inkling 2 Mini (`128K` context, `--slots 1`, `--hot-cache-max-size 12GB`):**
  - Active model + `64K` KV peak measured `24.39 GB` GPU RAM (`31,712` KV tokens add only `+0.91 GB` across `8` full-attention layers with `1024` sliding-window attention).
  - Raising `--context` to `131072` (`128K`) adds roughly `1.8 GB` at full context (`~26.2 GB` active), plus up to `12 GB` hot KV prefix cache (`~38 GB` upper ceiling).
  - Leaves roughly `26 GiB` free for macOS, web browsers, and editors with low swap pressure.
- **Ornith 1.5 35B-A3B (`38 GB` resident budget via `splash-1.7.0-m1`):**
  - Run **either Inkling or Ornith one at a time**, never both simultaneously, so browser tabs and desktop apps stay responsive.
- **Keep `--slots 1`:** Doubling slots splits memory bandwidth and allocates extra concurrent KV state, slowing single-user interactive speed.

---

## 2. Compaction and Thinking Budget Math

Mid-turn truncation (`Response was truncated before completion` / `finish_reason=length`) happens when `compaction.reserveTokens` is smaller than `maxTokens`:

- If `contextWindow = 131072`, `maxTokens = 16384`, and `reserveTokens = 8192`:
  - At `118,000` prompt tokens, Pi does not compact yet, so it shrinks `request_max_tokens` down to remaining space.
  - A long thinking + code-writing turn burns past the shrunk cap and hits `finish_reason=length`, discarding that partial tool call and triggering an emergency compaction.
- **Working rule:** Set `reserveTokens` larger than `maxTokens` plus safety margin:
  - `reserveTokens: 24576` triggers clean compaction between tool calls around `106,496` tokens (`81.25%` of `131072`), guaranteeing a full `16384`-token output runway on every turn.
  - `keepRecentTokens: 12000` keeps the post-compaction recent slice focused so the next cold prefill finishes sooner.
  - Set `modelThinkingLevels["inkling-local/inkling"] = "medium"` so routine CSV/file exploration does not burn 3,000+ reasoning tokens per step. Switch to `low` for mechanical loops or `high` for hard architecture decisions.

---

## 3. Protecting the oMLX Prefix Cache

Hybrid architectures using sliding-window attention and recurrent GDN layers require exact prefix matching from token `0`:

- **Keep chat history append-only during a task.** Avoid extensions that rewrite, edit, or delete earlier assistant/tool messages mid-session, because mutating earlier tokens forces a `1` to `2` minute cold re-prefill in **oMLX**.
- **Keep static system prompts small and stable.** Stripping global MCPs, skills, `codemode`, and cloud tools via `pi-local` drops turn-1 base tokens from `11,328` down to `4,974` (`pi-local`) or `1,846` (`pi-local --bare`).
- **Avoid `/reload` mid-session.** Changing tools or prompts mid-run shifts the prefix and invalidates cached KV blocks.

---

## 4. Plugin and Harness Compatibility Matrix

| Tool / Extension | Role on Local oMLX | Prefix-Cache Safe? | Recommendation |
| --- | --- | --- | --- |
| `pi-handoff` | Generates a crisp brief into a brand-new session (`/handoff`) | Yes (fresh session) | **Use between major phases** |
| `pi-continue` | Compacts safely before overflow using a disk continuation ledger | Yes (native cut point) | **Optional safety net for single long runs** |
| `pi-subagents` | Isolates noisy exploration into child sessions | Yes (isolated runs) | **Use sequentially (`pi-local --subagents`)** |
| `pi-tool-repair` / `pi-token-speed` / `@erichll/pi-statusline` | Repairs malformed tool JSON and displays speed metrics | Yes | **Keep enabled in `pi-local`** |
| `pi-auto-compact` | Prompts preflight threshold warning/compaction | Yes | Useful in global Pi; `pi-continue` covers mid-run checkpoints |
| Mid-history pruners (`pi-smart-compact`, `pi-context-kit`, `cprune`) | Deletes old tool outputs from earlier turns | No (breaks prefix from token 0) | Best for cloud APIs, skip for hybrid local **oMLX** models |
| `rtk` (CLI output compressor) | Compresses verbose shell stdout before entering history | Yes | Good companion for heavy build/test logs |

Note: `pi-continue` emits an npm deprecation notice as of `0.9.3`, so test updates over time and pass `--no-continue` to `pi-local` if you prefer pure `/handoff` phase resets.

---

## 5. Subagent Concurrency Rules

- **Simultaneous local generations:** **`1` at a time** on `--slots 1`. Parallel local subagents contend for M1 Max memory bandwidth.
- **Sequential local subagents per project:** **`3` to `5` focused child stages** (for example: Stage 1 schema profiler, Stage 2 data pipeline, Stage 3 verification pass, Stage 4 HTML report builder). Each child starts small (`1.8K` to `6.8K` base tokens), works quickly, writes artifacts to disk, and returns a short summary so the parent never overflows.
- **Hybrid local + cloud workflow:** Run `1` local Inkling subagent alongside `3` to `5` parallel cloud subagents (fast small/flash cloud models) for web lookups or parallel code reviews.
- Set child subagents to **`low` thinking** unless deep reasoning is specifically needed.

---

## 6. Progressive Disclosure and Disk Memory

1. **Always create `notes.md` early.** Record verified column spellings, key counts, edge cases, generated file paths, and open TODOs. After any compaction or `/handoff`, read `notes.md` first.
2. **Never dump raw CSVs or giant JSON blobs into stdout.** Write scripts that inspect schema + row counts + `3` to `5` sample rows, compute distributions in Python, and write full outputs to disk (`results.json`, `review.html`). Cap printed summaries under `40` lines.
3. **Write `.py` files with `write`/`edit` tools.** Avoid multi-hundred-line inline shell heredocs, which clutter context and waste generation tokens if truncated.
4. **Handoff at natural phase boundaries.** Once Phase 1 data analysis is verified and saved, run `/handoff Build the review UI from results.json and notes.md` so Phase 2 decodes at full speed in a fresh window.
