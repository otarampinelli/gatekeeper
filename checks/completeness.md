---
name: Completeness
description: Flag changes that landed in one place but not at every place they needed to
group: scope
hints:
  - Use when a change edits a shared type, enum, union, signature, or a pattern that repeats across the diff.
  - new enum, union, or status variant
  - changed function or component signature
  - shared type or contract changes
  - read path updated without write path
  - one of several parallel call sites touched
---

Review the diff for changes that were applied inconsistently — the edit is correct where
it landed, but an equivalent spot that needed the same edit was missed. Unlike
Code Quality (which judges the changed lines on their own), this check judges whether the
change is *finished*.

Work primarily from the diff. When the diff gives you a concrete symbol to chase (an enum
member, a renamed field, a changed parameter), a targeted search for that one symbol's
other uses is in scope. Do not embark on open-ended repository exploration.

Fail the check if any of these are true:

- **Unhandled new variant**: a union, enum, status, or discriminated type gains a member,
  but a `switch`, `if`/`else` chain, mapping object, label/copy record, icon or color map,
  or filter list that enumerates the other members was not updated
- **Missed call site**: a function, composable, or component signature changes (new
  required param, reordered args, renamed prop, changed return shape) and a caller visible
  in the diff — or found by searching for that symbol — still uses the old shape
- **Half-updated pair**: one side of a symmetric pair changed without the other. Examples:
  a write path updated but not the read path that parses it, serialize without
  deserialize, create without update, a soft-delete that no restore path accounts for, an
  optimistic client update that no longer matches the server result
- **Partial rename**: a field, table, route, event name, or permission key is renamed and
  the old name still appears in the diff or in a spot the diff clearly should have touched
- **Inconsistent repeated fix**: the diff applies the same corrective change (a guard, an
  `await`, a scoping filter, a null check) to several near-identical sites but skips one
- **Contract drift across the boundary**: a shared type or schema validator changes on
  one side of an API/UI boundary while the consumer in the diff still assumes the old
  shape

Do not fail the check for:

- Deliberate divergence the diff makes evident — a new variant intentionally handled by an
  existing default or fallback branch, or a legacy call site left on an explicitly
  retained overload
- Staged rollouts where the diff or PR description states the remaining call sites are
  follow-up work, and the intermediate state is safe
- Pre-existing inconsistencies in files the diff merely touched for another reason
- Additive changes with no exhaustive consumer: an optional field, a new variant that
  every consumer legitimately ignores, a new export with no existing readers
- Cases where the type system already forces the update (an exhaustive discriminated
  union with no default branch will fail the build, not review)

When you flag something, name the changed symbol, name the specific spot that was missed,
and state what the missed spot does today with the new input. Prefer "the `archived`
status was added to the `Status` enum but the `STATUS_LABELS` map has no entry, so
archived items render a blank label" over a general note about exhaustiveness.

If the change is applied consistently everywhere it needed to be, pass the check.
