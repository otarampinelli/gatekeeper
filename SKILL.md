---
name: gatekeeper
description: Runs review checks from .gatekeeper/checks against either local changes or a GitHub PR, summarizes results, fixes local findings by triage, and previews/posts inline comments for PR reviews. Use when the user says "/gatekeeper", "run gatekeeper", or "run the checks" before pushing or when reviewing a PR.
---

# Gatekeeper — Check Runner

Run every `.gatekeeper/checks/*.md` check against the selected review source. Each check
is judged by its own isolated sub-agent, in parallel, so one check's reasoning
never influences another's verdict.

This skill is the runner. The repo's review policy lives in the check files.

Keep the runner generic and keep repo-specific rules inside `.gatekeeper/checks/*.md`.

## Workflow

### 1. Choose review source

This runner supports two input modes:

- local changes in the current repo
- a GitHub PR link

If the user provides a GitHub PR URL, review that PR instead of the local working tree.

GitHub PR mode requires the GitHub CLI.

Before using PR mode:

1. verify `gh` is installed
2. verify `gh` is authenticated and can access the PR

If either check fails, stop and tell the user what is missing.

Do not try to install `gh` for the user. Ask them to install it first.

Examples:

- `/gatekeeper` -> review local changes
- `/gatekeeper security-review` -> review local changes with one check
- `/gatekeeper https://github.com/org/repo/pull/123` -> review that PR with all checks
- `/gatekeeper security-review https://github.com/org/repo/pull/123` -> review that PR with one check

### 2. Gather context (write to disk, NOT into your context)

Prepare two temp files for the checks:

- `/tmp/gatekeeper-diff.patch`
- `/tmp/gatekeeper-log.txt`

Run these as **discrete, simple commands** (not one giant chained one-liner) so they
can be safely added to each agent's allowlist and won't trigger a fresh permission
prompt every run.

For local changes:

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
   If `main` does not exist, use `git log HEAD --oneline > /tmp/gatekeeper-log.txt`.

For GitHub PR mode:

1. Write the PR diff:
   `gh pr diff <pr-url> > /tmp/gatekeeper-diff.patch`
2. Write a concise commit log for the PR:
   `gh pr view <pr-url> --json commits --template '{{range .commits}}{{printf "%.7s %s\n" .oid .messageHeadline}}{{end}}' > /tmp/gatekeeper-log.txt`

If every diff is empty, tell the user there are no changes to review and stop.

**Do NOT read these files back into your own context.** The sub-agents read them directly.

### 3. Infer intent and recommend checks

Only do this step if the user did not explicitly name which checks to run.

If the user specifies one or more checks, skip intent inference and run the requested
checks.

Otherwise, do a lightweight intent pass over:

- the changed paths
- the diff
- the commit log

Use that pass to produce:

1. a short summary of the likely change intent
2. a recommendation for which checks to run
3. a confidence judgment: narrow, mixed, or unclear

This is a recommendation layer, not a strict policy layer.

Do not assume the model fully understands the PR. Use intent to narrow obvious cases,
but widen coverage when the change is broad or ambiguous.

Use the intent pass to recommend checks from the currently available check files.

Do not hardcode the recommendation logic to a fixed set of check names. Checks may be
added, removed, or renamed over time.

To build a recommendation:

1. discover the available checks in `.gatekeeper/checks/*.md`
2. read each check's `name` and `description`; use optional recommendation metadata if it
   exists, but do not require it
3. compare the inferred intent and changed paths to the available checks
4. recommend the smallest reasonable set of checks that clearly matches the change
5. if the match is weak, the change is mixed-purpose, or the change is sprawling, run
   all checks

Prefer recommendation logic that is driven by the check files themselves, not by a
fixed mapping embedded in the runner.

If the intent looks narrow and the recommendation is high confidence, it is fine to
recommend a subset of the currently available checks instead of all checks.

If the change looks mixed-purpose, sprawling, or hard to classify, recommend all checks.

Always print the recommendation before running checks. Example:

```text
Likely intent: add input validation to the user registration endpoint.
Recommended checks: Security Review, Test Coverage.
Confidence: narrow.
```

### 4. Decide scope

If the user explicitly asks for specific checks, run only those checks and skip the
recommendation layer.

Otherwise, use the recommended checks from the intent pass.

If there is no clear recommendation, or the change is mixed or unclear, run every check
in `.gatekeeper/checks/*.md`.

Accept either:

- the filename stem, for example `security-review`
- the derived display name, for example `Security Review`
- a clear partial match when it is unambiguous, for example `security`

If a requested name matches more than one check, ask the user which one they want.

If a requested check does not exist, tell the user which checks are available and stop.

Examples:

- `/gatekeeper` -> run all checks
- `/gatekeeper security-review` -> run only `.gatekeeper/checks/security-review.md`
- `run gatekeeper for Security Review` -> run only `.gatekeeper/checks/security-review.md`

### 5. Discover checks

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
- Before running anything, print the checks that will run.

### 6. Run checks in parallel (background sub-agents)

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

### 7. Collect results & deduplicate

After all agents complete, read just the last 30 lines of each output file:
`tail -30 {output_file}`. Parse PASS/FAIL and extract each finding (file, line,
problem, code suggestion).

**Deduplicate findings.** Different checks often flag the *same* underlying problem
(e.g. both Security Review and Code Quality flag the same hardcoded password at
`database.ts:12`). Merge findings that point to the **same file + line + root
issue** into ONE finding. Record which checks flagged it (e.g. "flagged by Security
Review + Code Quality") and keep a single code suggestion. Do not merge findings
that are genuinely different problems, even in the same file.

### 8. Summarize results (ALWAYS — before any triage)

You MUST print this summary table before doing anything else. Do not rely on the
sub-agents' "Done" status — a completed sub-agent does NOT mean the check passed.
The only source of truth is the PASS/FAIL line in each agent's output.

List **one row per deduplicated finding**. A finding flagged by multiple checks gets
ONE row listing those checks. A check that passed cleanly gets a single ✅ row.

```
🛡️  Gatekeeper — N checks

| Finding                                   | Flagged by                  |
|-------------------------------------------|-----------------------------|
| ❌ Hardcoded DB password — database.ts:12   | Security Review, Code Quality |
| ❌ Unused import — utils.ts:33              | Code Quality                  |
| ✅ Test Coverage — passed                  | Test Coverage               |

X findings across Y checks.
```

If every check passed, say so explicitly and stop — there is nothing to triage.

### 9. External PR review follow-up (GitHub PR mode only)

Only do this step when the review source is a GitHub PR URL and something failed.

GitHub PR mode is an external review flow. Treat the PR as someone else's work by
default: do not check out the PR branch, do not offer to fix locally, and do not show
the per-finding "Fix it" / "Skip" triage cards.

After printing the required Gatekeeper summary, generate planned inline PR comments
for every finding that can be anchored to changed lines in the PR diff. Then render
the exact planned comments in chat and ask whether to post them. In PR mode, the
default flow is:

1. run the checks
2. print the Gatekeeper summary
3. build and render planned Gatekeeper-labeled inline PR comments
4. ask whether to post all comments, choose comments, or stop

AskUserQuestion options:

- **Post all inline PR comments** — post every planned comment exactly as previewed
- **Choose comments** — ask once with one checkbox option per planned comment, then
  post only the selected comments
- **Stop** — leave the PR untouched

Do not post a top-level PR summary comment.

Only post inline comments when the finding can be anchored to a changed line in the PR
diff. If a finding cannot be anchored safely, do not create a top-level fallback
comment; report the unposted finding in chat after posting the anchored comments.

Each inline comment body must clearly mark that it came from Gatekeeper. Keep the
visible comment concise.

For code-related findings, always explain what the problem is and how to solve it in
prose. Before rendering the planned inline comments, attempt to build a small `diff`
code block from the changed line or contiguous changed lines for every code-related
finding. If the fix is local and mechanical (delete a line, replace an expression,
remove a no-op block, swap an unsafe call for a safer call, etc.), the planned comment
must include the diff block inside a `<details>` section with
`<summary>Proposed fix</summary>`. If the fix is not local to the commented line
(for example, adding a new test file, wiring configuration elsewhere, or a broader
design change), still post the inline comment with the problem and prose fix guidance;
omit the `<details>` section.

For non-code findings, do not add a suggested-fix `<details>` section. Put any
recommendation in concise visible prose instead.

Code-related inline comment example:

````markdown
🛡️ **Gatekeeper** flagged this via `<check name>`.

**<short finding title>**

<one concise explanation of the problem>

Suggested fix: <one concise explanation of how to solve it>

<details>
<summary>Proposed fix</summary>

```diff
<minimal context>
- <old code>
+ <new code>
<minimal context>
```

</details>
````

Non-code inline comment example:

```markdown
🛡️ **Gatekeeper** flagged this via `<check name>`.

**<short finding title>**

<one concise explanation of the problem>

Suggested fix: <one concise prose fix>
```

To post inline comments, use the GitHub pull request review comments API via `gh api`.
Resolve the PR number and head commit first:

```bash
gh pr view <pr-url> --json number,headRefOid
```

Then post each anchored finding:

````bash
gh api repos/<owner>/<repo>/pulls/<number>/comments \
  -f body="$(cat <<'EOF'
🛡️ **Gatekeeper** flagged this via `<check name>`.

**<short finding title>**

<one concise explanation of the problem>

Suggested fix: <one concise explanation of how to solve it>

<details>
<summary>Proposed fix</summary>

```diff
<minimal context>
- <old code>
+ <new code>
<minimal context>
```

</details>
EOF
)" \
  -f commit_id="<headRefOid>" \
  -f path="<file-path>" \
  -F line=<changed-line-number> \
  -f side=RIGHT
````

For non-code findings, use the non-code comment example above for the `body` instead
of the diff-block body; do not include a suggested-fix `<details>` section.

Keep inline comments concise. Include:

- the 🛡️ `Gatekeeper` label
- the check name(s) that flagged the issue
- one sentence explaining the problem
- one concise prose explanation of how to solve it
- for code-related fixes, a `<details>` section with
  `<summary>Proposed fix</summary>` and a small `diff` code block whenever the fix is
  local and mechanical
- for non-code fixes, concise visible prose without a suggested-fix `<details>`
  section

Every posted comment must say what the problem is and how to solve it. For code-related
fixes, include a `diff` block whenever the replacement code is clear enough to be
useful as a reference. Do not render planned inline comments for local/mechanical
code fixes until you have attempted to build those diffs.

Do not post inline comments if every check passed.

### 10. Triage local findings (local mode only)

Only do this step when the review source is local changes and something failed.

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
   `src/database.ts:12` · flagged by Security Review + Code Quality

   Password is committed in source instead of read from the environment.

   ```diff
   -     password: '1223456789',
   +     password: process.env.DB_PASSWORD,
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
   1. Hardcoded DB password at database.ts:12

   Switch to process.env.DB_PASSWORD?

   -     password: '1223456789',
   +     password: process.env.DB_PASSWORD,
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

### 11. Clean up

After triage (or after the summary if everything passed), remove the temp handoff
files: `rm -f /tmp/gatekeeper-diff.patch /tmp/gatekeeper-log.txt`.

## Design Notes

- Keep the runner stable.
- Keep checks small and focused.
- Put repo-specific review policy in check files, not in the runner.
- Avoid over-specifying presentation details unless they are necessary for
  correct behavior.
- Prefer small, additive changes to the runner over large workflow rewrites.
