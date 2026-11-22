# Copy-Paste Prompts for Local LLM Workflows

## 1. Large CSV and Tabular Analysis (Phase 1: Discovery and Scripted Pipeline)

```text
Objective:
[Describe what you need analyzed and what outputs to produce.]

Rules for working cleanly in local context:
1. Maintain a concise `notes.md` file in this directory with exact file names, CSV column names, verified row counts, decisions, and next pending steps. Update it after each step.
2. Start with a small `inspect_schema.py` script that prints column names, row counts, null rates, and 3 to 5 sample values per file. Stream any large CSV line by line instead of loading huge raw tables into chat.
3. Put all reusable logic into `.py` script files using write/edit tools instead of giant inline shell heredocs. Edit functions in place.
4. Keep printed stdout summaries under 40 lines. Write detailed outputs (JSON, CSV, or HTML) directly to disk.
5. Finish Phase 1 with verified summary numbers saved to disk, then stop so we can review or run `/handoff` for the UI/report phase.
```

---

## 2. Large Codebase Refactoring or Feature Build

```text
Follow this phased workflow:
1. Create or update `notes.md` with target files, interfaces, test commands, and milestone checklist.
2. Inspect only the relevant symbol locations first (`rg -n`), then read small line ranges instead of whole files.
3. Implement one milestone at a time, run targeted tests printing concise failure/summary output only, and update `notes.md`.
4. After passing tests on a major phase, tell me we are at a clean `/handoff` checkpoint.
```

---

## 3. Mid-Session Steering Nudge (Before Compaction or After Truncation)

```text
Pause before writing more large code. Save everything we have verified so far into `notes.md`: exact schemas/column spellings, key row counts, created file paths, and next steps. Move analysis code into a `.py` file on disk and print only a short summary under 30 lines.
```

---

## 4. Clean Phase Transition (`/handoff`)

Run inside `pi-local` after finishing Phase 1:

```text
/handoff Build the final deliverable reading `notes.md` and the structured JSON/data files on disk. Do not re-run Phase 1 discovery unless a field check fails.
```
