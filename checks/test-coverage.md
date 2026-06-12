---
name: Test Coverage
description: Flag new logic that ships without tests
hints:
  - Use when a change adds meaningful behavior, fixes a bug, or changes logic that should be exercised by tests.
  - new logic
  - bug fixes
  - branching behavior
  - changed handlers or workflows
  - missing nearby test updates
---

Review the diff for meaningful logic that was added or changed without accompanying
tests. The goal is to catch untested behavior, not to demand tests for everything.
Flag meaningful coverage gaps even when they are not explicitly listed below.

Scope is strictly limited to code touched by the current diff:

- Only evaluate behavior introduced or changed in this diff
- Ignore pre-existing test gaps that are not part of this diff
- Do not ask for tests in unrelated files, modules, or historical code paths
- If a touched file has adjacent legacy logic, only comment on the changed behavior

Fail the check when meaningful behavior introduced or changed by the diff is not
adequately exercised by tests.

Common examples of inadequate coverage (non-exhaustive):

- A new function or method with real logic (branching, calculation, data transformation,
  error handling) was added with no test exercising it
- An existing function's behavior changed (new branch, changed condition, new edge case)
  but no test was added or updated to cover the new path
- A bug fix was made with no regression test that would have caught the original bug
- A new public API / endpoint / exported function has no test for its success and
  failure cases
- Coverage only exercises happy paths while meaningful failure, error, or edge-case
  behavior introduced by the change remains untested

No action is needed when:

- The change is pure config, types, comments, formatting, or renames
- The change is trivial pass-through with no logic to test
- A test file was added/updated alongside the change and covers the new behavior
- The touched area does not have an established automated test setup; in this
  case, prefer an Info-level suggestion instead of a hard fail

When you flag something, name the specific function or behavior that lacks a test and
describe the case that should be covered (e.g. "`processPayment()` has no test for the
declined-card path").

If new logic is adequately covered, pass the check.

When suggesting or evaluating tests, prefer:

- Minimal mocking of internal implementation details when behavior can be tested through public interfaces
- Assertions that verify observable behavior and outcomes, not implementation trivia
- Test descriptions that clearly state scenario and expected result
- Coverage for both success and non-happy paths when the changed logic introduces both
