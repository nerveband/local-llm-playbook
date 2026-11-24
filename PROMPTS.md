# Copy-Paste Prompts for Local LLM Workflows

## 1. Large CSV and Tabular Analysis (Phase 1: Discovery and Scripted Pipeline)

```text
Objective:
[Describe what you need analyzed and what outputs to produce.]

Rules for working cleanly in local context:
1. Maintain a concise `notes.md` file in this directory with exact file names, CSV column names, verified row counts, decisions, and next pending steps. Update it after each step.
2. Start with a small `inspect_schema.py` script that prints column names, row counts, null rates, and 3 to 5 sample values per file. Stream any large CSV line by line instead of loading huge raw tables into chat.
3. Put all reusable logic into concise `.py` script files (`250` to `350` lines when possible) using `write`/`edit` tools instead of giant inline shell heredocs. Edit functions in place.
4. Keep printed stdout summaries under 20 lines. Write detailed, compact outputs to disk (keep embedded JSON reports under `6 MB`, storing summary fields per record rather than full raw blobs).
5. Finish Phase 1 with verified summary numbers and `notes.md` saved on disk, then call `phase_handoff` (`auto_continue: false`) so I can review before Phase 2.
```

Add these two lines instead if you want hands-free automatic transition to Phase 2 without stopping for review (remember to state explicitly that the final phase must not call `phase_handoff` again):

```text
When Phase 1 is complete and verified on disk, update `notes.md` and call `phase_handoff` with `auto_continue: true` and a self-contained Phase 2 task prompt, then stop calling tools so Pi starts Phase 2 in a fresh session automatically. After Phase 2 finishes and passes verification, stop directly without calling `phase_handoff` again.
```

---

## 2. Large Codebase Refactoring or Feature Build

```text
Follow this phased workflow:
1. Create or update `notes.md` with target files, interfaces, test commands, and milestone checklist.
2. Inspect only the relevant symbol locations first (`rg -n`), then read small line ranges instead of whole files.
3. Implement one milestone at a time, run targeted tests printing concise failure/summary output only, and update `notes.md`.
4. After passing tests on a major phase, call `phase_handoff` (`auto_continue: false`) so we can start the next phase in a fresh session via `/next-phase`.
```

---

## 3. Mid-Session Steering Nudge (Before Compaction or After Truncation)

```text
Pause before writing more large code. Save everything verified so far into `notes.md` (exact schemas/column spellings, key row counts, created file paths, and next steps), then call `phase_handoff` so we continue cleanly in a fresh session.
```

---

## 4. Clean Phase Transition (`/next-phase` or `/handoff`)

When the model calls `phase_handoff` with `auto_continue: false`:

```text
/next-phase
```

You can also add adjustments directly:

```text
/next-phase Tighten score threshold to >= 75 for auto-merge and use a light editorial HTML layout.
```

Or trigger a manual handoff anytime without calling `phase_handoff`:

```text
/handoff Build the final deliverable reading `notes.md` and the structured JSON/data files on disk. Do not re-run Phase 1 discovery unless a field check fails.
```
