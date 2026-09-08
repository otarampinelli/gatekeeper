---
name: gatekeeper
description: Runs review checks from .gatekeeper/checks against either local changes or a GitHub PR, gathers deterministic evidence, verifies every candidate finding before reporting it, then fixes local findings by triage or previews/posts inline PR comments. Use when the user says "/gatekeeper", "run gatekeeper", or "run the checks" before pushing or when reviewing a PR.
---

# Gatekeeper - Check Runner

Review a change against `.gatekeeper/checks/*.md`, in one of exactly two modes:

- **local** — the user's uncommitted and unpushed work, reviewed so they can fix it before pushing.
- **PR** — someone's pull request, reviewed as a tagged reviewer would: inline comments on the PR, nothing edited locally.

Gatekeeper is a hybrid: a deterministic engine does the mechanical work, and you do the
judgment. Stay on your side of that line.

| The `gk` engine owns | You own |
|---|---|
| base pinning, diff capture, PR worktree | inferring intent, recommending checks |
| manifest, churn, renames, declarations | the reviews themselves (sub-agents) |
| `applies_to` gating, grouping checks into agents | verification reasoning (sub-agents) |
| running analyzers, reading CI, caching | merging near-duplicate findings |
| neighborhood/reference mapping | triage conversation, comment prose |
| filling in every agent prompt | |
| parsing, dedupe, ranking, dismissals, state | |

**Never reimplement an engine stage by hand.** Do not build the diff with shell commands,
do not hand-write the manifest, do not retype an agent prompt, do not eyeball whether a
finding was dismissed before. If a `gk` command fails, report the error — do not improvise
a replacement. The engine exists so these answers are identical every run and cost no
context.

## The engine

`.gatekeeper/bin/gk.mjs` — zero dependencies, plain node. Every command prints compact JSON
to stdout and writes bulk artifacts to disk. Read the artifacts only when you need a
specific detail; hand their paths to sub-agents instead.

```bash
node .gatekeeper/bin/gk.mjs help
```

Commands: `prepare`, `context`, `parse`, `rank`, `dismiss`, `cleanup`.

Run state lives in `<git-common-dir>/gatekeeper/` — inside `.git`, so it is never
committed. `dismissals.json` and `cache/` persist across runs; `runs/<id>/` holds one
review pass.

The engine's pure functions are tested. If you change one, run them:

```bash
node --test '.gatekeeper/test/*.test.mjs'
```

## Flags

- `--deep` — also run analyzers marked `deep: true` (slow ones: full typechecks, tests)
- `--no-verify` — skip verification (faster, noisier; the summary says so)
- `--fresh` — ignore previously dismissed findings

---

### 1. Choose review source

- no argument -> local changes
- a GitHub PR URL or number -> that PR, in an isolated worktree

Examples:

- `/gatekeeper` -> local changes, all applicable checks
- `/gatekeeper security-review` -> local changes, one check
- `/gatekeeper https://github.com/org/repo/pull/123` -> that PR
- `/gatekeeper security-review 123` -> one check against PR 123

### 2. Prepare

```bash
node .gatekeeper/bin/gk.mjs prepare              # local
node .gatekeeper/bin/gk.mjs prepare --pr <url>   # PR
```

This one command pins the base to the merge-base, captures the excluded diff, builds the
manifest, gates checks by `applies_to`, and groups the survivors into agents. In PR mode it
also verifies `gh`, fetches the PR head, and creates a detached worktree so the user's
checkout is never touched.

Keep `runDir` from the output — every later command needs `--run <runDir>`.

If `empty: true`, tell the user there is nothing to review and stop.

If it reports an error, relay it and stop. Missing or unauthenticated `gh` is the user's
to fix; never try to install it.

Tell the user what it found — file count, the checks that will run, how many agents that
is, and how many checks were gated out. In PR mode mention that a worktree is being
created, since it takes a moment on a large repo.

**If `wide: true`, stop and ask before running everything.** The patch is large enough that
the full check set is expensive no matter how it is grouped, and `applies_to` cannot help:
a sweep that touches every path gates in every check. Report `patchTokens`, say plainly
that a full review is not worth it at this size, and ask which checks matter. Proceed with
the full set only if the user says so.

### 3. Recommend checks (your judgment)

Skip this entirely if the user named specific checks — run exactly those.

Otherwise read `manifest.md` from the run directory. Use the manifest, not the raw diff:
it already separates moves and reindents from real behavior change, and reading the patch
here wastes context you will need later.

Produce:

1. a one-line summary of the likely intent
2. the smallest set of the already-gated checks that clearly matches
3. confidence: narrow, mixed, or unclear

Build this from each check's `name`, `description`, and `hints` as reported by `prepare`.
Never hardcode a mapping — checks get added and renamed.

Widen to every gated-in check when the change is mixed-purpose, sprawling, or hard to
classify. `applies_to` already removed what cannot possibly apply, so the remaining set is
a safe default — unless `wide: true`, where it is not.

```text
Likely intent: new form validation on the checkout page.
Gated out: 9 checks (no matching paths).
Recommended: UI / Component Placement, Test Coverage, Simplicity.
Confidence: narrow.
```

If a requested check does not exist, list what is available and stop. If a name is
ambiguous, ask.

### 4. Gather context

```bash
node .gatekeeper/bin/gk.mjs context --run <runDir> [--checks a,b] [--deep]
```

Pass `--checks` with the stems you settled on in step 3; omit it to cover everything
`prepare` gated in. This runs `.gatekeeper/analyzers.mjs` from the review root, caches each
analyzer against its own input file hashes, maps who references the changed exported
symbols, and writes one ready-to-use review prompt per agent into `prompts/`. It fails
soft — a timeout or crash becomes `skipped` with a reason, never an aborted review.

Two things in the `neighborhood` block are worth surfacing to the user, because they are
signals no agent needs to hunt for:

- `orphanSymbols` — exported symbols with no references anywhere
- `filesWithoutTests` — changed source files whose symbols appear in no test

In PR mode `context` also reads the check runs attached to the reviewed commit. Those are
the same jobs the `needsInstall: true` analyzers would run, already executed against this
exact commit, so those analyzers skip with CI named as their covering source. A fresh
worktree has no `node_modules`; never install dependencies to change that, and never
describe a skipped analyzer as passing.

Surface the `ci` block (PR mode only — absent from `context`'s output for local review).
Three things in it change what the review means:

- `note` — the PR targets something other than the default branch, so workflows gated to
  that branch never fired and the board is thin by construction. Tell the user: a
  three-job board is not a green one.
- `failed` — the failing output is already in `evidence.md`; mention it before the agents
  run, since it usually reframes what the review is about.
- pending jobs, which land in the `skipped` count — still running is not passing.

### 5. Run the checks (sub-agents produce candidates)

`context` returned an `agents` array. Spawn one sub-agent per entry,
`subagent_type: "general-purpose"`, `run_in_background: true`, **all in a single message**.

Each agent's prompt is already written and fully substituted. Read the file and pass its
contents as the prompt — do not compose one yourself, and do not edit it.

```text
Read this file and follow it exactly: <agents[i].prompt>
```

An agent may carry several checks. That is deliberate: the checks with no `applies_to`
survive gating on every review and each read the whole patch, so one agent per check meant
paying many times over for the same bytes. The prompt tells the agent to keep each check's
result in its own file, and every finding is still verified independently.

Agents write to `<runDir>/candidates/` and return `DONE`, so their output never passes
through your context.

### 6. Parse

```bash
node .gatekeeper/bin/gk.mjs parse --run <runDir>
```

Aggregates every candidate file, merges exact duplicates across checks, unions their
evidence, escalates to the highest severity, assigns stable ids (`F01`, `F02`), and writes
batched verification prompts. Parsing is lenient — a malformed finding degrades rather than
disappearing.

Two fields need your judgment:

- `possibleDuplicates` — same file and line, different titles. The engine will not merge
  these because collapsing two genuinely different problems is worse than showing both.
  Decide, and say what you merged.
- `alreadyDismissed` — the user declined this before. Still verify it; `rank` handles the
  suppression.

If `reports: 0`, the agents wrote nothing. Say so rather than reporting a clean pass.

### 7. Verify (sub-agents, adversarial)

Skip only with `--no-verify`.

This is what makes the review trustworthy. Generation and verification must stay separate:
an agent that just argued for a finding is the wrong one to judge it. Cost scales with
findings, not with checks or repo size, so this is cheap next to step 5.

`parse` returned a `verifyAgents` array. Spawn one sub-agent per entry, all in a single
message, passing each prompt file the same way as step 5. Each agent writes one
`<runDir>/verdicts/<id>.txt` per finding it was given.

An unparseable verdict is treated as UNPROVEN, never CONFIRMED — the engine fails closed.

### 8. Rank and summarize

```bash
node .gatekeeper/bin/gk.mjs rank --run <runDir> [--no-verify] [--fresh]
```

Applies the reporting gate deterministically: `CONFIRMED` reports; `UNPROVEN` Error reports
labeled unproven; `REJECTED`, low-severity `UNPROVEN`, and dismissed findings suppress.

**Print the returned `summary` verbatim, before any triage.** It already carries the
suppression tally, the evidence line, and the churn note. A verification layer that
silently swallows findings is indistinguishable from a broken one, so never hide the
tally.

If nothing is reported, say so plainly and go to step 10.

### 9. Report

#### 9a. GitHub PR mode

PR mode is an external review. Treat the PR as someone else's work: never offer to fix it
locally, never show the per-finding "Fix it" / "Skip" cards.

Build planned inline comments from `reported.json` for every finding that anchors to a
changed line, render them exactly as they will be posted, then ask:

- **Post all inline PR comments** — post every planned comment as previewed
- **Choose comments** — one checkbox per comment, post only those
- **Stop** — leave the PR untouched

No top-level summary comment. Only post comments that anchor to a changed line; report
unanchorable findings in chat. Build diff blocks from the finding's stored `diff` — do not
re-read files.

````markdown
🛡️ **Gatekeeper** flagged this via `<check name>`.

**<short finding title>**

<one concise explanation of the problem>

<the evidence line verification confirmed>

Suggested fix: <one concise explanation of how to solve it>

<details>
<summary>Proposed fix</summary>

```diff
- <old code>
+ <new code>
```

</details>
````

Design and non-code findings use the same body without the `<details>` block.

```bash
gh pr view <pr-url> --json number,headRefOid
```

```bash
gh api repos/<owner>/<repo>/pulls/<number>/comments \
  -f body="$(cat <<'EOF'
<body from above>
EOF
)" \
  -f commit_id="<headRefOid>" \
  -f path="<file-path>" \
  -F line=<changed-line-number> \
  -f side=RIGHT
```

#### 9b. Local mode triage

Triage one finding at a time — each distinct problem gets its own AskUserQuestion item.

Everything you need is in `reported.json`: explanation, evidence, fix, and diff. No file
re-reads.

**Print the cards in a normal chat message FIRST, then ask.** AskUserQuestion renders its
text as plain text, so ```diff fences get no red/green colouring inside the widget. The
polished version belongs in your message; the widget stays a thin control.

1. One card per finding, `---` divider after each:

   ````
   ### 🔴 Hardcoded DB password
   `src/api/app.module.ts:925` · confirmed · flagged by Security Review + Code Quality

   Password is committed in source instead of read from the environment.

   Evidence: app.module.ts:925 passes a literal; no env fallback in this module.

   ```diff
   -     password: '1223456789',
   +     password: process.env.PG_PASSWORD,
   ```
   ---
   ````

   Severity emoji: 🔴 Error, 🟡 Warning, 🔵 Info. Label unproven findings as unproven on
   the context line.

2. Then AskUserQuestion, structured so the suggestion is visible:

   ```
   1. Hardcoded DB password at app.module.ts:925

   Switch to process.env.PG_PASSWORD?

   -     password: '1223456789',
   +     password: process.env.PG_PASSWORD,
   ```

   - Header: `<file> — flagged by <check(s)>`
   - Exactly two options. Do NOT add a custom/"reply in chat" option — AskUserQuestion
     already provides a built-in "Other: (type to answer)".
     - **Fix it** — apply the suggestion
     - **Skip** — leave it, and record the dismissal
   - Honour a custom instruction given via "Other".

Batch up to 4 per call. Print all cards for the batch, then ask together. Only edit
changed files; never touch pre-existing issues in unchanged code.

For every finding the user skipped, record it so it is never asked again:

```bash
node .gatekeeper/bin/gk.mjs dismiss --run <runDir> --id F02,F05 --date <YYYY-MM-DD>
```

`--date` is required: the engine has no trusted clock, so pass today's date from your
context.

### 10. Clean up

```bash
node .gatekeeper/bin/gk.mjs cleanup --now <ISO-timestamp>
```

Removes every Gatekeeper worktree and prunes runs older than 30 days. It never touches
`dismissals.json` or `cache/`, and it is idempotent.

**Run this on every exit path** — success, nothing found, an analyzer crash, a failed
check, or the user abandoning triage. A leaked worktree keeps a stale checkout on disk and
dirties `git worktree list` in the user's repo. If `warnings` is non-empty, relay the exact
command the user should run.

## Design Notes

- Everything Gatekeeper owns lives under `.gatekeeper/`: the engine (`bin/`, `lib/`), its
  tests (`test/`), the policy (`checks/`, `analyzers.mjs`), and these skill definitions
  (`skills/`). `.agents/skills/*` and `.claude/skills/*` are symlinks into `skills/` so
  each agent harness discovers the skill without owning a second copy. Copying
  `.gatekeeper/` into another repo brings the whole reviewer with it.
- Inside that directory the engine/policy split still holds. `bin/` and `lib/` are generic
  and know nothing about this repo; `checks/` and `analyzers.mjs` are entirely
  repo-specific. Deleting a check or `analyzers.mjs` degrades a review without breaking the
  engine.
- Determinism before the agents is what makes a wide fan-out affordable. Every stage the
  engine owns is computed once and shared. Resist moving that work into agents or into
  your own context.
- Agent count is the cost, not prompt length. The patch dominates what an agent reads, so
  grouping checks onto fewer agents is the only large lever — trimming prompt wording is
  rounding error.
- Agents write findings to disk and return `DONE`. Bulk review text must never flow
  through the orchestrator.
- Never report an unverified finding. Precision is the product; a reviewer that cries wolf
  gets muted.
- Prefer extending a `gk` subcommand over adding shell steps back into this file.
