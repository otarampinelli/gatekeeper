---
name: gatekeeper-writing-checks
description: Write or edit .gatekeeper/checks markdown files for local or PR-based Gatekeeper review. Use when the user asks to create, add, design, or update Gatekeeper checks.
---

# Gatekeeper Writing Checks

Use this skill when authoring check files for the Gatekeeper runner. Checks live at
`.gatekeeper/checks/<kebab-case-name>.md` and are run by the `gatekeeper` skill
against either:

- the current local diff
- or a GitHub PR diff

## What A Check Owns

A check defines **what to judge**.

A check does not define:

- how the runner gathers the diff
- how PASS/FAIL is formatted
- how findings are rendered in the final summary
- how triage questions are asked

Those are runner concerns. Keep the check focused on review policy.

## Check File Format

Each check is a markdown file with YAML frontmatter:

```markdown
---
name: Documentation Impact
description: Flag changes that should update product or engineering docs
hints:
  - Use when a change may alter user-visible behavior, architecture, or conventions.
  - new feature behavior
  - architecture changes
---

Review the diff for...
```

Required fields:

- `name`: short display name in title case
- `description`: one concise sentence describing what the check flags

Optional fields:

- `applies_to`: git pathspec globs. The runner skips this check entirely — before
  spawning any agent — when no changed file matches. Omit it for checks that apply to
  every change.
- `group`: which agent runs this check. Checks sharing a group share one agent. Omit it
  and the check gets an agent to itself.
- `hints`: a short list of cues that help the runner understand when this check is
  relevant

Keep optional metadata lightweight. `hints` are recommendation hints, not a strict rules
engine. When creating a new check, prefer adding `hints` unless there is a clear reason
not to. The Gatekeeper runner uses the check's `name`, `description`, and optional
`hints` when inferring intent and recommending which checks to run.

### `applies_to`

`applies_to` is a hard, deterministic gate — the difference between it and `hints` is
that `hints` inform an LLM recommendation while `applies_to` is evaluated with
`git diff --name-only` before any model call:

```yaml
applies_to:
  - "packages/api/**"
  - "apps/web/**"
```

Rules:

- Omit it when the check genuinely applies everywhere (`code-quality`, `test-coverage`,
  `security-review`). Absent means "always runs".
- Add it when the check names a specific app, package, or layer. A database-schema check
  should not spawn an agent for a docs-only change.
- Be generous inside the boundary. Scope to `apps/web/**`, not
  `apps/web/src/components/**` — a check gated too tightly silently stops running
  when code moves.
- Never use it to express severity or priority. It answers "could this check possibly
  have something to say about these paths", nothing more.

### `group`

One group is one agent. This is the review's main cost control: the patch dominates what
an agent reads, so two checks in the same group read it once instead of twice.

```yaml
group: quality
```

Rules:

- Group checks that read the same material. The checks with no `applies_to` survive gating
  on every review and all read the whole patch, so they benefit most. A path-gated family
  that always gates in together — every `apps/web/**` check, say — benefits the same
  way.
- Do not group checks that would blunt each other. `security-review` stays alone because a
  missed finding there costs more than the tokens saved.
- Grouping never merges concerns. Each check keeps its own file, its own instructions, and
  its own result file, and the agent is told to keep them separate. If two checks would be
  better as one check, merge the checks — do not express that with `group`.
- Aim for three or four members. The engine splits a group whose combined instructions get
  large enough to crowd the diff out of the agent's context, but a group that needs
  splitting is usually a group that was chosen badly.

After changing groups, confirm the shape is what you intended:

```bash
node .gatekeeper/bin/gk.mjs prepare
```

The output reports `agents` and the `groups` that produced them.

## Authoring Rules

- Keep one check focused on one concern. Split broad requests into multiple checks
  instead of writing one muddled super-check.
- Use concrete fail criteria. Prefer bullets like "A new REST endpoint accepts a body
  without validation" over vague instructions like "Check security."
- Include "Do not fail" criteria for common false positives.
- End with a clear pass condition.
- Write checks that start from the diff, manifest, and evidence handoff. The runner
  gives every agent a bounded exploration budget plus a `neighborhood.md` listing who
  references the changed code, so a check *may* require looking at a caller or a test —
  it must not require crawling the repo.
- Prefer deterministic evidence over inference. If a repo script or compiler already
  proves the thing your check cares about, say so in the check and let the analyzer in
  `.gatekeeper/analyzers.mjs` establish it; have the check reason about that output
  instead of re-deriving it.
- Require evidence, not suspicion. Tell the check that each finding must cite concrete
  `file:line` observations, because every finding goes through an adversarial
  verification pass that rejects anything it cannot reproduce.
- Make pre-existing-versus-introduced decidable. Where it matters, tell the check what
  would distinguish a defect the diff introduced from one it merely touched.
- Keep findings actionable: tell the check to name the changed file or behavior,
  explain the risk, and describe the fix in prose.
- If you add recommendation metadata, make it descriptive rather than exhaustive.
  The runner should be able to use it as a hint without treating it as a hard filter.
- Write `name`, `description`, and `hints` so they work for both:
  - explicit user selection, such as `/gatekeeper security-review`
  - automatic recommendation from PR or diff intent
- Match repo-specific rules when they exist. For example, a multi-tenant scoping check
  should cite the repo's actual scoping helpers and enforcement points by name, not a
  generic description of tenant isolation.
- Do not encode formatting or syntax rules that belong in linting. Gatekeeper checks
  are for judgment calls that require context.
- Name checks for discoverability. Prefer filenames and display names that a user
  would naturally ask for when running a single check.

## Naming Guidance

Prefer short, obvious names:

- `security-review.md` -> `Security Review`
- `test-coverage.md` -> `Test Coverage`
- `documentation-impact.md` -> `Documentation Impact`

Avoid names that are:

- too broad, like `Review`
- too clever, like `Guardian`
- too narrow to discover, like `validate-rbac-tenant-boundary-edge-cases`

If a user asks to run one check, they should be able to guess the name.

## Suggested Structure

```markdown
---
name: <Display Name>
description: <What this check flags>
group: <agent this check shares, or omit for its own>
applies_to:
  - "<path glob>"
hints:
  - <Short sentence describing when to consider this check>
  - <Short signal>
  - <Short signal>
---

Review the diff for <specific concern>.

Fail the check if any of these are true:

- <Concrete fail condition>
- <Concrete fail condition>

Do not fail the check for:

- <Common false positive>
- <Common false positive>

When you flag something, <state what evidence and fix guidance to include>.

If <pass condition>, pass the check.
```

## Good Check Characteristics

A strong Gatekeeper check is:

- narrow in scope
- clear about what fails
- clear about what does not fail
- judgeable from the diff plus a handful of targeted lookups
- specific about what evidence backs a finding
- self-describing enough for the runner to recommend it
- practical to act on

A weak Gatekeeper check is:

- vague
- duplicative of linting
- dependent on reading half the repo
- trying to enforce multiple unrelated concerns at once

## Workflow

1. Read nearby checks in `.gatekeeper/checks/` to match tone and granularity.
2. If updating an existing check, keep the edit surgical and preserve its intent.
3. If creating a new check, name the file with kebab case and keep the scope narrow.
4. Make sure the check still makes sense whether the diff came from local git state or
   from a PR URL.
5. If creating a new check, make sure `name`, `description`, and `hints` are good enough
   for the runner to discover, recommend, and run it without extra hardcoded logic, and
   set `applies_to` unless the check truly applies to every change.
6. After editing, read the final file and check diagnostics for the changed markdown.
