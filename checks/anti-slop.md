---
name: Anti-Slop
description: Flag AI-generated filler and low-signal noise in changed code
group: quality
hints:
  - Use when a change looks AI-assisted, unusually verbose, or filled with explanatory comments.
  - large generated-looking diff
  - comment-heavy changes
  - assistant-style prose left in code
  - defensive code with nothing to defend against
---

Review the diff for "AI slop" — low-signal filler that bloats the code without adding
value. This is code that looks plausible but a careful human wouldn't have written.

This check owns **noise**. Structural over-engineering belongs to Simplicity, duplicated
implementations belong to Reuse First, and documentation prose belongs to Prose Style. Do
not re-flag those here.

Fail the check if any of these are true:

- **Narrating comments** that just restate the code (`// increment i by 1`,
  `// loop through the items`, `// return the result`) — delete them
- **Obvious-from-name docstrings** that add nothing (`/** Gets the user */ getUser()`)
- **Over-explaining the obvious** in long comment blocks where the code is already clear
- **Leftover assistant prose** in code or comments (`// Here's the updated function`,
  `// As requested`, `// Note: this implementation...`, TODO restating the task)
- **Defensive bloat**: try/catch that swallows and rethrows the same error, null checks
  on values that cannot be null, validation already done upstream

Do not fail the check for:

- A genuinely useful comment — one that explains a non-obvious constraint, a workaround,
  or a deliberate trade-off
- Real defensive code at a trust boundary, where the input genuinely is untrusted
- Comment density that matches the surrounding file's existing style
- Anything an analyzer in `evidence.md` already reported

Only flag filler that makes the code longer and harder to read without making it better.

If the changed code is lean and intentional, pass the check.
