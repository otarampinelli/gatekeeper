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

Gatekeeper has two independent parts: an engine that runs once, globally, on your machine
(no matter how many projects you review), and a skill you install per AI tool that teaches
it to drive that engine. Neither one is language-specific: checks are plain-language
prompts your agent judges against the diff, not language-specific code, so the same engine
and the same bundled checks work unchanged in a JavaScript, Python, Rust, or Go repo.

**1. Install the engine globally (optional — the skill does this for you on first run):**

```bash
curl -fsSL https://raw.githubusercontent.com/otarampinelli/gatekeeper/main/setup.sh | bash
```

You don't have to run this yourself: the first time `/gatekeeper` runs in any project and
finds no engine at `~/.gatekeeper`, it runs this exact command automatically (see `SKILL.md`
step 0) before doing anything else. Run it manually ahead of time only if you also want
`gk` available for your own direct terminal use before installing any skill, or to update
an existing install (`git pull` under the hood, so it's safe to re-run any time).

It clones the engine to `~/.gatekeeper` and links `gk` into `~/.local/bin`. It never
touches the project you're reviewing: no `package.json`, no `node_modules/`, no Gatekeeper
runtime files land in a Rust repo, a Python repo, or anywhere else. Make sure
`~/.local/bin` is on your `PATH` — the script warns if it isn't. (If your shell aliases
`gk` to something else — oh-my-zsh's git plugin binds it to `gitk` — either drop that alias
or invoke `~/.gatekeeper/bin/gk.mjs` directly; skills do this automatically.)

Already have the repo cloned? Run `./setup.sh` from inside it instead — same script, no
network fetch needed for the script itself. Override `GATEKEEPER_HOME` or
`GATEKEEPER_BIN_DIR` if you want either somewhere other than the defaults above.

**2. Install the skill into your AI tool:**

```bash
npx skills add otarampinelli/gatekeeper --all
```

This drops only skill markdown into your tool's skills folder (`.agents/skills/gatekeeper`,
`.claude/skills/gatekeeper`, …) — no engine code. The first time you run `/gatekeeper`
anywhere, step 0 installs the engine (running `setup.sh` from step 1, if `~/.gatekeeper`
isn't there yet) and then runs `gk init`, which scaffolds that project's
`.gatekeeper/checks/` from the bundled templates if it doesn't already exist.
`.gatekeeper/analyzers.mjs` is optional and project-specific; write one yourself, or ask
your agent to, once you know which tools this project actually uses.

Only want the runner? `npx skills add otarampinelli/gatekeeper -s gatekeeper` installs just
`gatekeeper`, skipping the `writing-checks` authoring skill.

Already installed before this change? Older versions vendored a full copy of the engine
into each project's `.gatekeeper/bin`, `.gatekeeper/lib`, and `.gatekeeper/test`. Those are
no longer read or written by the skill — delete them freely; only `.gatekeeper/checks/` and
`.gatekeeper/analyzers.mjs` are still project state.

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

On first run, `gk init` scaffolds those templates into your project:

```text
your-project/
  .gatekeeper/
    checks/*.md
```

Copy, edit, and add your own checks there. `analyzers.mjs` has no default and no
per-language template: your agent already knows this project's actual toolchain (its lock
file, its test command, its lint config), so it can write one when asked, better than a
generic guess could. Commit `.gatekeeper/` with your repo so the whole team runs the same
checks and analyzers.

## Repository layout

Only `skills/` is skill-facing markdown — the part that gets installed into an AI tool's
skills folder. Everything else is the engine, installed once, globally, at `~/.gatekeeper`
(see `SKILL.md` step 0) — it is never copied into a reviewed project:

```text
.github/workflows/          # CI: runs `npm test` on push to main and on PRs
skills/
  gatekeeper/
    SKILL.md                # the installed /gatekeeper runner
    reports/pr-report.md    # step 9, PR mode: read only when the run is a PR review
    reports/local-report.md # step 9, local mode: read only when the run is a local review
  writing-checks/
    SKILL.md                # the gatekeeper-writing-checks skill (authoring guide)
checks/*.md                 # bundled, language-agnostic check templates gk init scaffolds
bin/gk.mjs                  # the deterministic engine CLI, resolved from its own location
lib/*.mjs                   # engine internals: diff capture, manifest, gating, findings
test/*.test.mjs             # unit tests for the engine's pure functions
setup.sh                    # installs/updates ~/.gatekeeper and links gk onto PATH
package.json
README.md
```

A project's `.gatekeeper/` folder is not the same as this repo's layout:

- `checks/*.md` here are the default templates the engine ships with.
- `.gatekeeper/checks/*.md` and `.gatekeeper/analyzers.mjs` in a project are that project's
  own policy — the only two files under `.gatekeeper/` the engine reads. `gk init` scaffolds
  `checks/*.md` if missing; `analyzers.mjs` has no scaffold and is entirely optional.
  Nothing under `~/.gatekeeper` is project-specific, and nothing engine-related is written
  into a reviewed project.

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
