---
name: Dead-End Code
description: Flag code the diff adds that nothing reaches
group: reach
hints:
  - Use when a change adds exports, routes, flags, permissions, migrations, props, or config that need a caller to matter.
  - new exported helper or module
  - new route, page, or endpoint
  - feature flag or setting
  - new permission key
  - new prop, slot, or emit
---

Review the diff for code that is added but unreachable — it compiles, it looks correct, and
nothing ever calls it. This differs from Code Quality's dead-code bullet, which targets
symbols unused *within* a file; this check targets additions whose consumer should exist
somewhere else and does not.

**Start from `neighborhood.md`.** Its `orphanSymbols` list is computed deterministically:
every newly exported symbol in the change set that ripgrep found no reference to anywhere in
the repository, plus a per-file `tests:` line. That list is your candidate set for the first
bullet below — do not re-derive it with your own searches. Spend your budget on the bullets
the engine cannot compute, and on confirming that an orphan is genuinely unreachable rather
than referenced in a way ripgrep's word-match missed (dynamic import, string-keyed registry,
template-only usage in a `.vue` file).

For the remaining bullets, judge from the diff plus a targeted search for the specific new
symbol's usage. If a search shows a legitimate consumer, there is no finding. Do not go
looking for unreachable code the diff did not add.

Fail the check if any of these are true:

- **Export with no importer**: a new exported function, composable, type, or constant that
  nothing in the diff or the repository imports. `neighborhood.md` already lists these under
  `orphanSymbols` — cite it as your evidence rather than repeating the search
- **Unrouted surface**: a new page or route component that no router entry, navigation
  config, or link reaches
- **Unread flag or setting**: a feature flag, env var, or config field is introduced but
  never read, or is read behind a condition that can never be true
- **Unenforced permission**: a permission key is registered in the app's permission map
  but no query, mutation, or client gate checks it — or the inverse, a gate that
  references a key never registered
- **Inert prop or event**: a component gains a prop, slot, or emit that no parent supplies
  or listens to, or a handler that is defined but never bound in the template
- **Unreferenced worker or job**: a new worker handler, scheduled function, or cron entry
  that no schedule, dispatcher, or event mapping invokes
- **Orphaned branch**: a new conditional branch or early return guarded by a condition the
  changed code cannot produce

Do not fail the check for:

- Public package API: exports from `packages/*` index files that exist for external
  consumers, and re-exports that widen a barrel
- Staged rollout the change makes explicit — a flag defaulted off, a route behind a gate,
  or scaffolding the PR description says a follow-up will wire up
- Test utilities, fixtures, and factories used only by tests
- Framework-convention entry points invoked by file location rather than import: Nuxt
  pages and plugins, route files, Convex `http` handlers, generated code
- Symbols consumed dynamically in ways a search will not show — string-keyed lookups,
  template-only references, or DI registration by token
- Deprecated code retained deliberately for compatibility during a migration
- Unregistered database migrations — a dedicated migrations check owns that case, if the
  repo has one; do not duplicate it here

When you flag something, name the added symbol and its file, say what should reach it, and
state whether the fix is to wire it up or to drop it. Prefer "`archivePermission` is
added to the permission map but no mutation asserts it, so archiving is currently
ungated" over a general note about unused code.

If everything the diff adds is reachable, or is deliberately staged, pass the check.
