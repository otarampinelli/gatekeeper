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

`~/.gatekeeper/bin/gk.mjs` — zero dependencies, plain node, installed once globally (see
step 0), never copied into the reviewed project. Every command prints compact JSON to
stdout and writes bulk artifacts to disk. Read the artifacts only when you need a specific
detail; hand their paths to sub-agents instead.

Invoke it through the resolved path, not the bare `gk` command: some shells alias `gk` to
something else (oh-my-zsh's git plugin binds it to `gitk`), and `command -v gk` reports the
alias as if it were the binary, so detection cannot rely on it either. Each command below
uses the full path directly for this reason:

```bash
node "$HOME/.gatekeeper/bin/gk.mjs" help
```

Commands: `init`, `review`, `prepare`, `context`, `parse`, `rank`, `dismiss`, `cleanup`.
`review` runs `prepare` + `context` in one call for a quick look; the step-by-step commands
below still apply since sub-agents must run between `context` and `parse`.

Run state lives in `<git-common-dir>/gatekeeper/` — inside `.git`, so it is never
committed. `dismissals.json` and `cache/` persist across runs; `runs/<id>/` holds one
review pass.

The engine's pure functions are tested. If you change one, run them from `~/.gatekeeper`:

```bash
node --test '**/*.test.mjs'
```

## Flags

- `--deep` — also run analyzers marked `deep: true` (slow ones: full typechecks, tests)
- `--no-verify` — skip verification (faster, noisier; the summary says so)
- `--fresh` — ignore previously dismissed findings
- `--base <ref>` — override the local-mode base revision (default: merge-base with the default branch)

---

### 0. Bootstrap the engine (first run only)

`gk`'s engine does not ship inside this skill folder — only this `SKILL.md` and `reports/`
do. It lives once, globally, at `~/.gatekeeper` (never copied into the reviewed project —
a Rust or Python repo run through Gatekeeper never gains a `package.json` or
`node_modules/`):

```bash
if [ ! -f "$HOME/.gatekeeper/bin/gk.mjs" ]; then
  git clone --depth 1 https://github.com/otarampinelli/gatekeeper.git "$HOME/.gatekeeper"
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.gatekeeper/bin/gk.mjs" "$HOME/.local/bin/gk"
fi
node "$HOME/.gatekeeper/bin/gk.mjs" init
```

Run this once per session, silently. `gk init` scaffolds `.gatekeeper/checks/` from the
bundled templates if it does not already exist — it never overwrites it, so a project's
customized checks are never clobbered by a later bootstrap. Tell the user `.gatekeeper/`
was created only when `gk init`'s `created` array is non-empty; a project that already had
its own config keeps it untouched.

`gk init` does not scaffold `.gatekeeper/analyzers.mjs` — there is no generic default that
beats what you can write once you've looked at this project's actual toolchain. If the user
wants deterministic evidence (lint, typecheck, tests) and none is configured yet, offer to
write `.gatekeeper/analyzers.mjs` yourself, using the format in this repo's `README.md`
("Writing analyzers"), rather than guessing a language-generic template.

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
node "$HOME/.gatekeeper/bin/gk.mjs" prepare              # local
node "$HOME/.gatekeeper/bin/gk.mjs" prepare --pr <url>   # PR
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
node "$HOME/.gatekeeper/bin/gk.mjs" context --run <runDir> [--checks a,b] [--deep]
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
node "$HOME/.gatekeeper/bin/gk.mjs" parse --run <runDir>
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
node "$HOME/.gatekeeper/bin/gk.mjs" rank --run <runDir> [--no-verify] [--fresh]
```

Applies the reporting gate deterministically: `CONFIRMED` reports; `UNPROVEN` Error reports
labeled unproven; `REJECTED`, low-severity `UNPROVEN`, and dismissed findings suppress.

**Print the returned `summary` verbatim, before any triage.** It already carries the
suppression tally, the evidence line, and the churn note. A verification layer that
silently swallows findings is indistinguishable from a broken one, so never hide the
tally.

If nothing is reported, say so plainly and go to step 10.

### 9. Report

`rank` returned `mode` and `reportGuide` — read only the file `reportGuide` names, not
whatever you recall from step 1.

- **local:** read and follow [`local-report.md`](./reports/local-report.md).
- **pr:** read and follow [`pr-report.md`](./reports/pr-report.md).

### 10. Clean up

```bash
node "$HOME/.gatekeeper/bin/gk.mjs" cleanup --now <ISO-timestamp>
```

Removes every Gatekeeper worktree and prunes runs older than 30 days. It never touches
`dismissals.json` or `cache/`, and it is idempotent.

**Run this on every exit path** — success, nothing found, an analyzer crash, a failed
check, or the user abandoning triage. A leaked worktree keeps a stale checkout on disk and
dirties `git worktree list` in the user's repo. If `warnings` is non-empty, relay the exact
command the user should run.

## Design Notes

- The engine (`bin/`, `lib/`) lives once, globally, at `~/.gatekeeper` — it knows nothing
  about any one project. A project's own `.gatekeeper/` holds only its policy: `checks/*.md`
  and `analyzers.mjs`, both entirely repo-specific and safe to commit. Deleting a check or
  `analyzers.mjs` degrades a review without breaking the engine. Only this `SKILL.md`, its
  `reports/`, and the `writing-checks` authoring skill live in the AI tool's skills folder;
  see Step 0 for how `~/.gatekeeper` and a project's `.gatekeeper/` each get populated.
- There is no per-language code anywhere in the engine. Checks are language-agnostic prose
  judged by you, gated purely by `applies_to` globs, so a new language needs no engine
  change — at most a new check whose globs target it.
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
