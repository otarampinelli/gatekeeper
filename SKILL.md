---
name: gatekeeper
description: Runs .gatekeeper/checks locally against the current changes, simulating an AI code-review. Use when the user says "/gatekeeper", "run gatekeeper", or "run the checks" to review their changes before pushing.
---

# Gatekeeper — Local Check Runner

Run every `.gatekeeper/checks/*.md` check against the current changes. Each check
is judged by its own isolated sub-agent, in parallel, so one check's reasoning
never influences another's verdict.

## Workflow

### 1. Gather context (write to disk, NOT into your context)

Run these as **discrete, simple commands** (not one giant chained one-liner) so they
can be safely added to each agent's allowlist and won't trigger a fresh permission
prompt every run. The exact commands are:

1. Make untracked (new) files visible to git diff. Plain `git diff` only shows tracked
   files, so brand-new files would be skipped. Intent-to-add makes them appear as
   additions without staging their content:
   `git add -N .`
2. Write the diff to `/tmp/gatekeeper-diff.patch`, capping it at 3000 lines in the
   SAME command by piping straight into `head` (do NOT write the file then truncate
   it afterwards — that needs a rewrite step and tempts you into python/awk). Review
   EVERYTHING that differs — committed, staged, unstaged, AND new files. Try these in
   order (use `master` if there is no `main` branch), stopping at the first whose
   output file is non-empty:
   - `git diff main | head -3000 > /tmp/gatekeeper-diff.patch`
   - if empty: `git diff HEAD | head -3000 > /tmp/gatekeeper-diff.patch`
   - if empty: `git diff | head -3000 > /tmp/gatekeeper-diff.patch`
   These are plain shell pipes — never reach for python, awk, or sed to build,
   truncate, or post-process the file.
3. Write the commit log: `git log main..HEAD --oneline > /tmp/gatekeeper-log.txt`.

- If there are no changes at all (every diff command is empty), tell the user and stop.
- **Do NOT read these files back into your own context.** The sub-agents read them directly.

### 2. Discover checks

- Discover check files with a bash command, NOT the Glob tool — `.gatekeeper/` is a
  hidden directory and Glob skips dotfolders. Use:
  `ls .gatekeeper/checks/*.md` (or `find .gatekeeper/checks -maxdepth 1 -name '*.md'`).
- **Do NOT read the check files.** Just take the filename and derive a display name
  (e.g. `security-review.md` -> "Security Review").
- **First-run bootstrap.** If `.gatekeeper/checks/` is missing or empty, the project
  has never been set up. Don't error out — offer to scaffold it. This skill ships
  default templates in `checks/` next to THIS `SKILL.md`.
  To bootstrap:
  1. Locate this skill's own directory (the folder containing the SKILL.md you're
     reading) and its `checks/` subfolder.
  2. Ask the user (AskUserQuestion) whether to copy those templates into
     `.gatekeeper/checks/`. On yes: `mkdir -p .gatekeeper/checks` then copy
     `checks/*.md` into it. On no: stop and tell them to add their own
     `.gatekeeper/checks/*.md`.
- After bootstrapping, re-run discovery and continue.
- Present the list of checks that will run, then proceed immediately without waiting.

### 3. Run checks in parallel (background sub-agents)

For each check file, spawn a sub-agent with:
- `subagent_type: "general-purpose"`
- `run_in_background: true`

Use this prompt structure:

```
You are a code reviewer running an automated check on a set of changes.

## Setup
1. Read your check instructions from: {absolute path to .gatekeeper/checks/xxx.md}
2. Read the diff from: /tmp/gatekeeper-diff.patch
3. Read the commit log from: /tmp/gatekeeper-log.txt

## Your Task
Review the diff according to your check instructions. Only judge the changed
lines. Work from the diff alone — do NOT open or read other files just to build
your answer (that slows the check down). Do not flag pre-existing issues in
unchanged code. For each finding provide:
1. Severity (Error / Warning / Info)
2. The specific file and line from the diff
3. A short explanation of what's wrong and how to fix it, in prose. You may quote
   the offending line and state the replacement inline (e.g. "change
   `password: '1223456789'` to read from `process.env.PG_PASSWORD`"), but do NOT
   construct a full ```diff block — the main runner does that later, only for the
   findings the user chooses to fix.

If everything looks good and you have no findings, say "PASS" and briefly explain
why the changes are clean for your check.

If you have findings, say "FAIL" and list them.

Keep your response concise. Do not repeat the whole diff back. Your final message
must start with either "PASS" or "FAIL" on its own line.
```

Launch ALL sub-agents in a single message (all Agent tool calls together).

### 4. Collect results & deduplicate

After all agents complete, read just the last 30 lines of each output file:
`tail -30 {output_file}`. Parse PASS/FAIL and extract each finding (file, line,
problem, code suggestion).

**Deduplicate findings.** Different checks often flag the *same* underlying problem
(e.g. both Security Review and Code Quality flag the same hardcoded password at
`app.module.ts:12`). Merge findings that point to the **same file + line + root
issue** into ONE finding. Record which checks flagged it (e.g. "flagged by Security
Review + Code Quality") and keep a single code suggestion. Do not merge findings
that are genuinely different problems, even in the same file.

### 5. Summarize results (ALWAYS — before any triage)

You MUST print this summary table before doing anything else. Do not rely on the
sub-agents' "Done" status — a completed sub-agent does NOT mean the check passed.
The only source of truth is the PASS/FAIL line in each agent's output.

List **one row per deduplicated finding**. A finding flagged by multiple checks gets
ONE row listing those checks. A check that passed cleanly gets a single ✅ row.

```
🛡️  Gatekeeper — N checks

| Finding                                   | Flagged by                  |
|-------------------------------------------|-----------------------------|
| ❌ Hardcoded DB password — app.module.ts:12 | Security Review, Code Quality |
| ❌ Unused import solDateMapUtil — documents.service.ts:33 | Code Quality   |
| ✅ Test Coverage — passed                  | Test Coverage               |

X findings across Y checks.
```

If every check passed, say so explicitly and stop — there is nothing to triage.

### 6. Triage findings (only if something failed)

Triage **one deduplicated finding at a time**. Each distinct problem gets its own
AskUserQuestion item so the user decides on each independently. Never merge two
genuinely different problems into one question; never split one problem into two
just because multiple checks flagged it.

**Build the diff suggestion HERE, not in the sub-agents.** The sub-agents return their
findings as prose (file/line + what's wrong + the replacement described inline) — that
keeps the parallel check phase fast. Now, only for the findings you are about to triage,
turn each prose suggestion into a `-`/`+` diff: read just the specific line(s) named in
the finding from that file (a few lines, not the whole file) and pair the original line
with the suggested replacement. You do this lazily, per finding, so the cost lands only
on real findings — never on checks that passed.

**Print the finding "cards" in the normal chat message FIRST, then ask.**
AskUserQuestion renders its question text as plain text — ```diff fences do NOT get
red/green coloring inside the question box. So the polished, colored version lives in
your regular assistant message (CommonMark, which renders identically in every agent
tool), and the question widget underneath stays a thin control. The flow per batch:

1. **Render each finding as a card** in your normal message. This card is plain
   CommonMark so it looks the same in Cursor, Claude Code, and any other tool. Use
   exactly this structure, with a `---` divider after each card:

   ````
   ### 🔴 Hardcoded DB password
   `apps/dockit-api/src/app.module.ts:925` · flagged by Security Review + Code Quality

   Password is committed in source instead of read from the environment.

   ```diff
   -     password: '1223456789',
   +     password: process.env.PG_PASSWORD,
   ```
   ---
   ````

   - Heading: `### <severity emoji> <short title>` — 🔴 Error, 🟡 Warning, 🔵 Info
   - Context line: `` `<file>:<line>` · flagged by <check(s)> `` (backticks make the
     path clickable in most tools)
   - One sentence describing the problem
   - The fix as a ```diff fenced block (`-` removed / `+` added) so it renders red/green
   - A `---` divider after each finding

2. Then call AskUserQuestion. Keep the question text **organized exactly like this** —
   numbered finding + file/line on the first line, a blank line, the question, a blank
   line, then the `-`/`+` suggestion lines:
   ```
   1. Hardcoded DB password at app.module.ts:925

   Switch to process.env.PG_PASSWORD?

   -     password: '1223456789',
   +     password: process.env.PG_PASSWORD,
   ```
   It renders as plain monochrome text in the widget (the colored version is in the card
   above), but the structure keeps it scannable. Do NOT use a vague pointer like "apply
   the fix shown above?".
   - Header: `<file> — flagged by <check(s)>`
   - Provide exactly two options — do NOT add a custom/"reply in chat" option, because
     AskUserQuestion already includes a built-in "Other: (type to answer)" free-text
     choice. Adding your own would duplicate it.
     - **Fix it** — apply the code suggestion
     - **Skip** — leave it as is
   If the user answers via the built-in "Other" with a custom instruction (e.g. "use
   an env var named DB_PASS"), follow that instruction for the finding.

Batch up to 4 findings per AskUserQuestion call; use multiple calls if there are more.
When batching, print all the findings + diffs for that batch first, then ask all of
them in one AskUserQuestion call. Then execute each choice — apply the suggestion,
skip, or follow the custom instruction. Only edit changed files; never touch
pre-existing issues in unchanged code.

### 7. Clean up

After triage (or after the summary if everything passed), remove the temp handoff
files: `rm -f /tmp/gatekeeper-diff.patch /tmp/gatekeeper-log.txt`.
