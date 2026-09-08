---
name: Code Quality
description: Flag obvious code-quality problems in the diff
group: quality
hints:
  - Use when a code change adds or reshapes implementation logic and you want a general quality pass.
  - refactors
  - new helpers or utilities
  - control-flow changes
  - debugging leftovers
  - dead code
---

Review the diff for code-quality problems that require judgment.

**Read `evidence.md` first.** The repo's linters already run before this check and their
output is handed to you as established fact. `no-unused-vars` and friends are theirs — an
unused import or variable is reported there, and repeating it here produces a duplicate
finding that costs the reader trust. Only flag a lint-class problem if it is genuinely
absent from `evidence.md` (for example a package with no linter configured).

Fail the check if any of these are true:

- Functions that are clearly doing too much (very long, deeply nested)
- Magic numbers or strings that should be named constants
- Missing error handling at an obvious boundary (network call, file I/O, parsing)
- Debugging leftovers (`console.log`, `print`, `debugger`, commented-out blocks of code)
  that no analyzer in `evidence.md` already reported

Do not fail the check for:

- Unused variables, imports, or functions — the linter owns these. Dead code whose
  *consumer* should exist elsewhere belongs to the Dead-End Code check.
- Anything already listed in `evidence.md`.

If none of these issues are found, pass the check.
