<div align="center">

```
       ██████╗  █████╗ ████████╗███████╗██╗  ██╗███████╗███████╗██████╗ ███████╗██████╗
      ██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝██║ ██╔╝██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗
      ██║  ███╗███████║   ██║   █████╗  █████╔╝ █████╗  █████╗  ██████╔╝█████╗  ██████╔╝
      ██║   ██║██╔══██║   ██║   ██╔══╝  ██╔═██╗ ██╔══╝  ██╔══╝  ██╔═══╝ ██╔══╝  ██╔══██╗
      ╚██████╔╝██║  ██║   ██║   ███████╗██║  ██╗███████╗███████╗██║     ███████╗██║  ██║
       ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝
```

**🛡️ AI code review for local changes and GitHub PRs, in the agent you already use.**

Define checks as markdown, run them with `/gatekeeper`, and skip the API keys and CI wiring: it runs right inside the agent you already have open.

</div>

---

## What is it?

Gatekeeper is a small code-review runner that isn't tied to any one AI tool. A **check**
is just a markdown file with a prompt in it: write down what you want reviewed, in plain
English. Type `/gatekeeper`, and a deterministic engine (`bin/gk.mjs`) grabs the diff
(your local changes or a GitHub PR), works out which checks actually apply, and hands each
one a review prompt sized to fit. Your coding agent does the actual judging, in parallel,
then double-checks its own findings before showing you anything. You get pass/fail with
fixes you can apply right away, either before you push or as comments on the PR.

It piggybacks on the AI agent you already have (**Claude Code**, **Cursor**, and any
tool that reads the skills convention), so there's nothing extra to configure.

## Install

This repo ships two skills: `gatekeeper` (the runner) and `gatekeeper-writing-checks`
(the authoring guide for `.gatekeeper/checks/*.md`). Both live under `skills/` in this
repo, so one command picks up both:

```bash
npx skills add otarampinelli/gatekeeper --all
```

That drops only the skill markdown into your tool's skills folder (`.agents/skills/gatekeeper`,
`.claude/skills/gatekeeper`, …) — no engine code, no tests, no `package.json`. The first
time you run `/gatekeeper`, it vendors the engine and default check templates into your
project's `.gatekeeper/` folder automatically (see `SKILL.md` step 0). Done.

Only want the runner? `npx skills add otarampinelli/gatekeeper -s gatekeeper` installs just
`gatekeeper`, skipping the authoring skill.

Already installed before this change? Your `.claude/skills/gatekeeper/` may still hold the
full old engine tree. Re-run the install command (or `npx skills update`) — it replaces the
skill folder outright, so the stale copy is gone on the next update.

## Use it

**Review local changes:**
```
/gatekeeper
```

**Review a GitHub PR:**
```
/gatekeeper https://github.com/org/repo/pull/123
```

**Run a specific check only:**
```
/gatekeeper security-review
/gatekeeper security-review https://github.com/org/repo/pull/123
```

**Local mode:** Gatekeeper will:

1. Snapshot your changes: committed, staged, unstaged, **and brand-new files** (marks new
   files intent-to-add so they show up in the diff; a normal, harmless git-index change
   that stays after the run).
2. Gate `.gatekeeper/checks/*.md` by `applies_to`, group the rest into agents, and run
   each group's checks in an isolated sub-agent, in parallel.
3. Verify every candidate finding before reporting it, then print a deduplicated summary.
4. Walk you through each finding with a colored diff and a **Fix it / Skip** choice.

**PR mode:** Gatekeeper will:

1. Fetch the PR diff and commit log via the GitHub CLI (`gh`), in a detached worktree.
2. Run the same gate → group → judge → verify pipeline as local mode.
3. Print a summary of findings.
4. Preview planned inline PR comments, then ask whether to post them.

Flags: `--deep` also runs analyzers marked slow (full typechecks, tests); `--no-verify`
skips the verification pass (faster, noisier); `--fresh` ignores previously dismissed
findings; `--base <ref>` overrides the local-mode base revision.

## Writing checks

A check is a markdown file in `.gatekeeper/checks/`. Frontmatter + a prompt:

```markdown
---
name: Security Review
description: Flag security issues in the diff
hints:
  - Use when a change touches auth, permissions, or external input handling.
  - new endpoints
  - secrets or sensitive logging
---

Review the diff. Fail the check if any of these are true:

- Hardcoded API keys, tokens, or passwords
- New endpoints without input validation
- SQL queries built with string concatenation
- Sensitive data logged to stdout

If none are found, pass the check.
```

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | ✅ | Shown in the results |
| `description` | ✅ | Short summary of what it checks |
| `applies_to` | - | Git pathspec globs. The check is skipped before any agent runs if no changed file matches. Omit it for checks that apply to every change |
| `group` | - | Checks sharing a `group` run in one agent instead of one each, so they share the cost of reading the diff |
| `hints` | - | Keywords/phrases that help the runner decide when to recommend this check |
| _body_ | ✅ | The prompt applied to your diff |

> Stick to one concern per check. One that tries to cover security, test coverage, and
> docs all at once just produces muddled results; split it into three instead.

See the [`writing-checks`](./skills/writing-checks/SKILL.md) skill in this repo for the full authoring guide.

## Writing analyzers

`.gatekeeper/analyzers.mjs` runs deterministic tools (linters, typechecks, tests) before
the checks do, so a check can cite tool output instead of re-deriving it:

```js
export default {
  diffExclude: ['**/_generated/**', '**/*.snap'],
  analyzers: [
    {
      name: 'eslint',
      when: ['**/*.ts', '**/*.tsx'],
      run: 'npx eslint {{changed_files}}',
      needsInstall: true,
    },
  ],
}
```

| Field | Purpose |
|-------|---------|
| `name` | Shown in `evidence.md` |
| `when` | Globs deciding whether this analyzer runs at all |
| `files` | Optional narrower globs for `{{changed_files}}` (defaults to `when`'s matches) |
| `run` | Shell command. Supports `{{base}}`, `{{review_root}}`, `{{changed_files}}` |
| `deep` | Only runs when `--deep` is passed |
| `needsInstall` | Skips when `node_modules` is missing (PR worktrees never install) |
| `timeout` | Seconds before the command is killed (default 120) |
| `expect` | `'report'` (default) treats a nonzero exit as findings, not a broken run |

Ten default check templates ship in [`checks/`](./checks):

| Check | What it catches |
|-------|----------------|
| **Security Review** | Hardcoded secrets, missing input validation, unsafe queries |
| **Code Quality** | Complexity, dead code, naming issues, anti-patterns |
| **Test Coverage** | New logic that ships without tests |
| **Anti-Slop** | AI-generated filler, low-effort code, vague naming |
| **Completeness** | An edit landed in one place but not every place it needed to |
| **Dead-End Code** | Added code that nothing reaches: no caller, no route, no consumer |
| **Documentation Impact** | Behavior or architecture changes that should update docs but didn't |
| **Prose Style** | Inconsistent, unclear, or bloated writing in docs and comments |
| **Scope Fidelity** | Changes that drift beyond what the PR/task actually asked for |
| **Simplicity** | Unneeded abstraction, indirection, or complexity |

On first run, Gatekeeper can copy those templates into your project:

```text
your-project/
  .gatekeeper/
    checks/*.md
```

Copy, edit, and add your own checks there. Commit `.gatekeeper/checks/` with your repo
so the whole team runs the same checks.

## Repository layout

Only `skills/` is skill-facing markdown — the part that gets installed into an AI tool's
skills folder. Everything else is engine code that gets vendored into a project's own
`.gatekeeper/` folder on first run instead (see `SKILL.md` step 0):

```text
.github/workflows/          # CI: runs `npm test` on push to main and on PRs
skills/
  gatekeeper/
    SKILL.md                # the installed /gatekeeper runner
    reports/pr-report.md    # step 9, PR mode: read only when the run is a PR review
    reports/local-report.md # step 9, local mode: read only when the run is a local review
  writing-checks/
    SKILL.md                # the gatekeeper-writing-checks skill (authoring guide)
checks/*.md                 # bundled check templates, vendored into .gatekeeper/checks/
bin/gk.mjs                  # the deterministic engine CLI, vendored into .gatekeeper/bin/
lib/*.mjs                   # engine internals: diff capture, manifest, gating, findings
test/engine.test.mjs        # unit tests for the engine's pure functions
package.json
README.md
```

A project's `.gatekeeper/` folder is not the same as this repo's layout:

- `checks/*.md` here are default templates that ship with the engine.
- `.gatekeeper/checks/*.md` in a project are the actual checks `/gatekeeper` runs there,
  alongside `.gatekeeper/analyzers.mjs`, that project's own deterministic-input policy.
- `.gatekeeper/bin/`, `.gatekeeper/lib/`, and `.gatekeeper/test/` in a project are a vendored
  copy of this repo's `bin/`, `lib/`, and `test/` — never touched by `npx skills add`, only
  by the bootstrap step in `SKILL.md`.

## How it works

Gatekeeper splits the work between a deterministic engine and your agent's judgment, see
the ownership table in [`SKILL.md`](./skills/gatekeeper/SKILL.md) for the full split.

There are two modes: local mode reviews your working tree, and PR mode fetches the diff
from GitHub through the `gh` CLI (in its own detached worktree) and posts findings back
as inline comments.

Checks that share a `group` run together in one sub-agent; everything else gets its own,
so one check's reasoning can't bleed into another's verdict. Every candidate finding then
goes through an adversarial verification pass before it's ever shown to you; nothing gets
reported just because an agent said so.

Local mode diffs against your base branch (`main` or `master`) and includes intent-to-add,
so it catches everything you're about to push, untracked files included. And since it's
all just a `SKILL.md` file, it works in any agent that follows the skills convention, not
just one tool.

---

<div align="center">
<sub>Built to be run, not configured. 🛡️</sub>
</div>
