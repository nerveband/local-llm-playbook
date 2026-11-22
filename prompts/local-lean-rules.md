# Local LLM Working Rules

Keep context small and fast on local inference:

1. Maintain a concise `notes.md` file in the working directory. Record exact CSV or data schemas, verified row counts, decisions, file paths created, and the next pending step. Update `notes.md` after each verified milestone.
2. Inspect schemas before analysis: run a short script to print column names, row counts, data types, and 3 to 5 sample rows. Stream large CSV files line by line instead of loading huge tables into chat or memory.
3. Write reusable `.py` or `.html` files using `write` and `edit` tools instead of bash heredocs (`<<EOF`). Keep edits small and verifiable.
4. Keep printed stdout summaries under 20 lines. Never dump raw CSV rows, full DataFrames, or large JSON blobs to stdout. Write full outputs (`.json`, `.csv`, `.html`) to disk.
5. Work in verified milestones: inspect schema, write script, verify totals, then build final deliverables.
6. Self-triggered phase boundary: when you finish a major phase or reach ~40K tokens (or see a local speed notice), update `notes.md` first, call `phase_handoff` only if another Pi phase remains (`auto_continue: false` to stop for user review, or `auto_continue: true` only when requested), and stop calling tools immediately.
