---
name: Prose Style
description: Flag changed documentation prose that breaks the Simplified Technical English standard
applies_to:
  - "**/*.md"
  - "**/*.mdx"
hints:
  - Use when a change adds or rewords documentation, specs, or long-form agent instructions.
  - docs under apps/documentation/content/docs
  - specs/
  - CLAUDE.md / AGENTS.md long-form sections
  - a reworded or restructured page
  - a rewrite that grew
---

Review changed markdown prose for writing-standard violations.

This check applies to prose under `apps/documentation/content/docs/`, `specs/`, and the
long-form sections of `CLAUDE.md` / `AGENTS.md` files. The standard is the "Writing
standard: Simplified Technical English" section of `.cursor/rules/docs-update.mdc`. Read it
before judging prose.

Fail the check if changed or added prose does any of these:

- **Em-dashes or en-dashes in a sentence** (`—`, `–`). A full stop, colon, or
  parentheses replaces them. Hyphens in compound modifiers (`workspace-scoped`) are fine
- **Bold or italic for emphasis** rather than to mark a term at its definition. Three or
  more bold fragments in one paragraph is a fail
- **Sentences over 25 words**, or over 20 words for a step the reader performs. Two
  facts joined by "and", "but", or a semicolon that should be two sentences
- **A stack of one-line paragraphs.** Short sentences are the goal; orphaning each one
  in its own paragraph is not. Paragraphs hold 2 to 6 related sentences. Three or more
  parallel facts belong in a bulleted list or a table, not in consecutive one-line
  paragraphs. This is the most common way an over-corrected rewrite fails
- **A shattered list.** The same fragmentation hides inside bullets: one substantive
  bullet split into six terse ones. A bullet may hold two or three sentences. If a diff
  roughly doubles a section's bullet count without adding facts, it fragmented the list
- **A rewrite that is materially longer than what it replaced.** Shorter sentences must
  not become more sentences. If a reworded page grew substantially, it was padded,
  fragmented, or it restates itself
- **An expanded abbreviation that needed no expansion.** "Application Programming
  Interface (API)", "Hypertext Transfer Protocol (HTTP)", "create, read, update and
  delete (CRUD)" are noise in an engineering doc. Rule 12 in the standard carries the
  do-not-expand list. Also fail an abbreviation invented by the rewrite that the
  original never used
- **Passive voice with a knowable actor** — "the row is read" instead of "the dispatcher
  reads the row"
- **Idiom, metaphor, humor, rhetorical questions, or second-person coaching** — "the
  whole design rests on one decision", "three things to internalize", "don't conflate
  them", "you might be tempted to", "here's the thing"
- **Filler openers** — "note that", "it is worth noting", "essentially", "simply", "of
  course", "at the end of the day". "In order to" should be "to"
- **A `TL;DR`, `Summary`, or `At a glance` block that restates the page** instead of
  putting the key fact in the first paragraph
- **Synonym drift** — the same concept called two things in one doc (`workspace` in one
  paragraph, "tenant" or "firm" or "org" in the next) when the code has one name for it
- **An undefined abbreviation** used before its first expansion on that page
- **Noun clusters longer than three words** — "workspace scoped case export gate"
- **Future or conditional tense for shipped behavior** — "will be created" for something
  the code does on every run
- **Facts deleted during a rewrite.** If a diff rewords a doc and a constraint, table
  row, caveat, code path, or link present in the old version is missing from the new
  version with no replacement, that is a fail regardless of how clean the new prose is

Do not fail the check for:

- Identifiers, schema names, product names, vendor names, or established terms of art
  that break a vocabulary rule (`accessGrants`, `transactional outbox`, `trigger.dev`).
  STE exempts Technical Names, and so do we
- Code blocks, mermaid diagrams, tables, frontmatter, or link targets. These are not
  prose and the sentence rules do not apply to them
- A long sentence that cannot be split without changing the meaning. Say why in the
  finding if you are unsure, rather than failing on word count alone
- Prose the diff did not touch. Judge the change, not the surrounding page
- Markdown that is not documentation — check files under `.gatekeeper/`, changelog
  entries, generated release notes, or a short README stub

If the changed prose follows the standard, pass the check.
