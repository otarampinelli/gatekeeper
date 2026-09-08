---
name: Documentation Impact
description: Flag changes that should update product or engineering docs
group: scope
hints:
  - Use when a change may alter user-visible behavior, architecture, operations, or project conventions.
  - new feature behavior
  - architecture or lifecycle changes
  - integration contract changes
  - RBAC or scoping changes
  - convention updates
---

Review the diff for changes that require documentation updates under the repo's docs
directory (`docs/`, `README.md`, or wherever this repo keeps product/engineering docs).

Fail the check if any of these are true:

- The change ships a new feature or meaningfully changes user-visible behavior, but no
  relevant product doc was added or updated
- The change alters a system's data model, lifecycle, mutation chokepoint, integration
  contract, or operational behavior, but no relevant engineering architecture doc was
  updated
- The change alters auth, RBAC, scoping, permissions, or another cross-cutting safety
  property, but the relevant architecture doc or scoping rule was not updated
- The change introduces or changes a cross-cutting coding convention, but no relevant
  convention doc or editor rule file was updated
- The change introduces genuinely new product or engineering behavior that would make
  existing docs misleading if left unchanged

Do not fail the check for:

- Pure refactors with no behavior, architecture, or convention change
- Tests, formatting, type-only changes, renames, or dead-code cleanup
- Narrow bug fixes where the documented behavior remains accurate
- Changes that do not create a durable new product or engineering contract

When you flag something, name the changed behavior or system and the likely doc area
that should be updated. Do not demand a brand-new doc if updating an existing one is
the simpler fit.

If the diff either includes the needed docs or has no documentation impact, pass the
check.
