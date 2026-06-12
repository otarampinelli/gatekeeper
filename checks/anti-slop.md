---
name: Anti-Slop
description: Flag AI-generated slop and low-effort filler in the diff
hints:
  - Use when a change looks AI-assisted, unusually verbose, abstraction-heavy, or filled with explanatory comments.
  - large generated-looking diff
  - comment-heavy changes
  - new wrappers or abstractions
  - repeated near-duplicate code
  - assistant-style prose
---

Review the diff for "AI slop" — low-signal filler that bloats the code without adding
value. This is code that looks plausible but a careful human wouldn't have written.
Fail the check if any of these are true:

- **Narrating comments** that just restate the code (`// increment i by 1`,
  `// loop through the items`, `// return the result`) — delete them
- **Obvious-from-name docstrings** that add nothing (`/** Gets the user */ getUser()`)
- **Redundant wrapper functions** that only call through to one other function with no
  added logic
- **Unnecessary abstraction**: new interfaces, factories, or config objects with a
  single implementation and no foreseeable second one
- **Defensive bloat**: try/catch that swallows and rethrows the same error, null checks
  on values that cannot be null, validation already done upstream
- **Leftover assistant prose** in code or comments (`// Here's the updated function`,
  `// As requested`, `// Note: this implementation...`, TODO restating the task)
- **Over-explaining the obvious** in long comment blocks where the code is already clear
- **Copy-pasted near-duplicate blocks** that differ only by a literal and should be one
  parameterized function

Be pragmatic: a genuinely useful comment, a deliberate abstraction, or real defensive
code at a trust boundary is NOT slop. Only flag filler that makes the code longer and
harder to read without making it better.

If the changed code is lean and intentional, pass the check.
