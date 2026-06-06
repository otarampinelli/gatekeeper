<div align="center">

```
 ██████╗  █████╗ ████████╗███████╗██╗  ██╗███████╗███████╗██████╗ ███████╗██████╗
██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝██║ ██╔╝██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗
██║  ███╗███████║   ██║   █████╗  █████╔╝ █████╗  █████╗  ██████╔╝█████╗  ██████╔╝
██║   ██║██╔══██║   ██║   ██╔══╝  ██╔═██╗ ██╔══╝  ██╔══╝  ██╔═══╝ ██╔══╝  ██╔══██╗
╚██████╔╝██║  ██║   ██║   ███████╗██║  ██╗███████╗███████╗██║     ███████╗██║  ██║
 ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝
```

**🛡️ AI code review that runs locally, in the agent you already use.**

Define checks as markdown. Run them on your changes with `/gatekeeper`. No API key, no CI, no extra service.

</div>

---

## What is it?

Gatekeeper is a tiny, tool-agnostic code-review runner. A **check** is just a markdown
file with a prompt. When you type `/gatekeeper`, your coding agent reads your local
changes, runs every check against them in parallel, and shows you pass/fail with
ready-to-apply fixes — right before you push.

It piggybacks on the AI agent you already have (**Claude Code**, **Cursor**, and any
tool that reads the skills convention), so
there's nothing extra to configure.

## Install

```bash
npx skills add otarampinelli/gatekeeper
```

That drops the `gatekeeper` skill into your tool's skills folder (`.agents/skills/gatekeeper`,
`.claude/skills/gatekeeper`, …). The first time you run `/gatekeeper`, it offers to scaffold
`.gatekeeper/checks/` in your project. Done.

## Use it

```
/gatekeeper
```

Gatekeeper will:

1. Snapshot your changes — committed, staged, unstaged, **and brand-new files**.
2. Run every `.gatekeeper/checks/*.md` in an isolated sub-agent, in parallel.
3. Print a summary of findings (deduplicated across checks).
4. Walk you through each finding with a colored diff and a **Fix it / Skip** choice.

## Writing checks

A check is a markdown file in `.gatekeeper/checks/`. Frontmatter + a prompt:

```markdown
---
name: Security Review
description: Flag security issues in the diff
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
| _body_ | ✅ | The prompt applied to your diff |

> One concern per check. A check that tries to cover security *and* test coverage *and*
> docs produces muddled results — split it into three.

Four default check templates ship in [`checks/`](./checks):

| Check | What it catches |
|-------|----------------|
| **Security Review** | Hardcoded secrets, missing input validation, unsafe queries |
| **Code Quality** | Complexity, dead code, naming issues, anti-patterns |
| **Test Coverage** | New logic that ships without tests |
| **Anti-Slop** | AI-generated filler, low-effort code, vague naming |

On first run, Gatekeeper can copy those templates into your project:

```text
your-project/
  .gatekeeper/
    checks/*.md
```

Copy, edit, and add your own checks there. Commit `.gatekeeper/checks/` with your repo
so the whole team runs the same checks.

## Repository layout

This repo is a single skill package:

```text
SKILL.md          # the installed /gatekeeper runner
checks/*.md       # bundled templates copied on first run
README.md
```

The installed skill folder is not the same as a project's `.gatekeeper/` folder:

- `checks/*.md` are default templates that ship with the skill.
- `.gatekeeper/checks/*.md` are the actual checks `/gatekeeper` runs in a project.

## How it works

- **Local only.** Your diff never leaves your machine; it's reviewed by the agent you're
  already running.
- **Isolated checks.** Each check runs in its own sub-agent, so one check's reasoning
  never bleeds into another's verdict.
- **Reviews real changes.** Uses `git diff` against your base branch (`main`/`master`)
  plus intent-to-add, so it catches everything you're about to push — including
  untracked files.
- **Tool-agnostic.** The same `SKILL.md` works in any agent that follows the `skills`
  convention.

---

<div align="center">
<sub>Built to be run, not configured. 🛡️</sub>
</div>
