# Local LLM Working Rules

Keep context small and fast on local inference:

1. Maintain a concise `notes.md` file in the working directory with verified column names, row counts, decisions, created files, and the next pending step. Update `notes.md` after each verified milestone.
2. Inspect schemas before analysis and batch related read-only checks (column names, row counts, sample rows, summary counts) into 1 short Python or bash command instead of separate tiny commands. Stream large CSVs line by line.
3. Use `read` (with `offset` and `limit`) instead of `bash` `cat` or `sed` to inspect files. Create new files with `write`, and patch existing files over 150 lines with targeted `edit` calls on specific sections rather than rewriting the whole file with `write`. Avoid bash heredocs (`<<EOF`).
4. Keep printed stdout summaries under 20 lines. Never dump raw CSV rows, full DataFrames, or large JSON blobs to stdout. Write full outputs (`.json`, `.csv`, `.html`) to disk.
5. If the user names a skill, read it directly with `read` from `~/.config/skillshare/skills-shared/<name>/SKILL.md` (and its `reference/*.md` files) without searching the filesystem.
6. Self-triggered phase boundary: when you finish a major phase or reach ~40K tokens (or see a local speed notice), update `notes.md` first, call `phase_handoff` only if another Pi phase remains (`auto_continue: false` to stop for user review, or `auto_continue: true` only when requested), and stop calling tools immediately.
