---
name: Scope Fidelity
description: Flag mismatches between what the change claims to do and what the diff actually does
group: scope
hints:
  - Use when the PR or commit log states an intent that should be checked against the delivered code.
  - stated feature or fix that may be incomplete
  - stubbed or placeholder implementation
  - unrelated changes bundled in
  - PR title narrower or broader than the diff
  - spec or ticket referenced by the change
---

Review the diff against its stated intent — the PR title and description, the commit log,
and any spec under `specs/` the change references. Every other check asks whether the code
is good; this one asks whether it is the code that was promised.

Use the diff plus the stated intent as your evidence. If a referenced spec file is in the
repository, reading it is in scope. Do not infer requirements the change never claimed.

Fail the check if any of these are true:

- **Undelivered claim**: the title or description states behavior the diff does not
  implement. A `feat:` that only adds types, a `fix:` with no change to the faulty path,
  a described endpoint or screen that is absent
- **Stub presented as done**: a code path the description implies is working is actually a
  placeholder — a handler that returns a hardcoded value, a submit that does not submit, a
  `TODO`/`throw new Error('not implemented')` on the primary path — and neither the title
  nor the description marks it as stubbed
- **Silent scope creep**: the diff makes substantive changes to behavior, dependencies, or
  configuration that the stated intent does not mention and that are not incidental to it.
  A drive-by refactor of an unrelated module, an unmentioned dependency bump, a config or
  workflow change unrelated to the feature
- **Prefix mismatch** under the repo's conventional-commit convention: a `chore:` or
  `refactor:` that changes user-visible behavior, or a `refactor:` that alters semantics
  rather than structure
- **Spec divergence**: the change cites a spec under `specs/`, but implements behavior that
  contradicts it without noting the deviation
- **Partial fix framed as complete**: the description claims a bug is fixed, but the diff
  addresses one trigger of it while leaving an obviously equivalent trigger in the same
  changed code untouched

Do not fail the check for:

- Explicitly staged work: the description states what is out of scope, deferred, or
  intentionally stubbed. Honest scoping passes even when the feature is incomplete
- Necessary incidental changes — a type, import, fixture, lockfile, or test update the
  stated work genuinely requires
- Small, clearly related cleanups in the files the change already touches
- Sparse descriptions where the title alone is accurate for what the diff does
- A missing spec reference when no spec exists for the work
- Judging whether the intent itself is the right product decision — that is not this check

When you flag something, quote or paraphrase the specific claim, state what the diff does
instead, and say which of the two should change: implement the missing behavior, or restate
the intent to match what shipped. Prefer "the description says the lead form submits to the
intake endpoint, but the handler in `src/components/LeadForm.vue` resolves without
calling it" over a general note about scope.

If the diff delivers what it claims, and claims what it delivers, pass the check.
