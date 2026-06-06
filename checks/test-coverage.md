---
name: Test Coverage
description: Flag new logic that ships without tests
---

Review the diff for meaningful logic that was added or changed without accompanying
tests. The goal is to catch untested behavior, not to demand tests for everything.

Fail the check if any of these are true:

- A **new function or method with real logic** (branching, calculation, data
  transformation, error handling) was added with no test exercising it
- An existing function's **behavior changed** (new branch, changed condition, new edge
  case) but no test was added or updated to cover the new path
- A **bug fix** was made with no regression test that would have caught the bug
- A new **public API / endpoint / exported function** has no test for its success and
  failure cases

No action is needed when:

- The change is pure config, types, comments, formatting, or renames
- The change is trivial pass-through with no logic to test
- A test file *was* added/updated alongside the change and covers the new behavior

When you flag something, name the specific function or behavior that lacks a test and
describe the case that should be covered (e.g. "`processPayment()` has no test for the
declined-card path").

If new logic is adequately covered, pass the check.
