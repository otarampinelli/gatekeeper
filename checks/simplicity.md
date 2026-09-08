---
name: Simplicity
description: Flag code structured more heavily than the problem warrants — wrong-fit data structures and over-engineering
group: quality
hints:
  - Use when a change introduces new data structures, abstractions, or control flow and you want to check it is right-sized for the problem.
  - new data structures (maps, sets, classes, nested objects)
  - generic type params or options/config objects
  - elaborate control flow
  - speculative generality
---

Review the diff for solutions that are more complex than the problem they solve. Unlike
Anti-Slop (which targets low-signal noise like narrating comments and leftover assistant
prose), this check targets the *shape* of the solution: a data structure or abstraction
that is heavier or wrong for what the code actually does, even when every line carries
signal.

Fail the check if any of these are true:

- **Redundant pass-through**: a wrapper function that only calls one other function, or a
  type alias whose right-hand side is *exactly another named type* with nothing added —
  e.g. `export type A = B` or `type A = B`. This is a second name for one concept; flag it
  and recommend using `B` directly. Do NOT exempt it because it "bridges vocabulary",
  "marks a module boundary", "documents intent", or "might diverge later" — a bare rename
  is over-structure until a real divergence (a union, `Omit`, generic instantiation,
  intersection, or added members) actually exists in the code. A `type A = B & {...}`,
  `Omit<B, ...>`, `B<T>`, or union genuinely composes — that is NOT flagged.
- **Unnecessary abstraction**: new interfaces, factories, or config objects with a single
  implementation and no foreseeable second one.

- **Wrong-fit data structure**: the container does not match how the data is used.
  Examples: a `Map`/keyed object that is only ever read with one known key or is built
  and then immediately iterated back into a list; a `Set` whose membership is never
  tested (only iterated); a wrapper object holding a single field that is always
  destructured at the point of use; parallel arrays kept in sync where one array of
  objects fits (or an array repeatedly scanned by id where a `Map`/record fits); an
  enum or discriminated union with only one variant.
- **Speculative generality**: generic type params, options/config objects, or function
  parameters that take exactly one value at every call site in the diff, with no second
  caller in sight. Recommend inlining the single concrete case.
- **Single-implementation abstraction with no state**: a class that holds no state and
  only groups functions, or a class instantiated once and used as a one-shot call —
  plain functions fit.
- **Over-elaborate control flow**: nested conditionals or loops that reduce to a direct
  expression, an early return, or a single `map`/`filter`/`find`. This includes
  hand-rolled logic that duplicates a standard built-in (a manual accumulation loop that
  is really a `map`, a hand-written clone, etc.).
- **Verbose value construction**: a multi-statement sequence with throwaway intermediate
  variables that builds a value a single clear expression (object literal, ternary,
  chained array method) would express more directly.

Do not fail the check for:

- Complexity that is genuinely proportional to a complex problem.
- Data structures chosen for a real, stated performance reason (e.g. a `Map`/`Set` for
  hot lookups over a large collection).
- Structures or abstractions that match an established pattern in the surrounding code,
  even if a lone instance would look heavy.
- A single-use intermediate variable that names a non-obvious value and aids readability.
- An abstraction with a second real caller or a concrete, imminent second use visible in
  the diff.

When you flag something, name the changed file and symbol, state which structure or
construct is oversized and how the code actually uses it, and describe the simpler shape
in prose (e.g. "replace the `Map<string, X>` keyed only by `id` with a plain array and
`find`").

If the solution's shape and data structures match the problem's actual complexity, pass
the check.
