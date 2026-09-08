// Agent prompts, rendered by the engine.
//
// These used to live in the skill, where the orchestrating model substituted the review
// root, the base revision, and every check stem, finding id, title and evidence block by
// hand — upwards of thirty substitutions a run. Filling a template has one correct answer,
// which puts it on this side of the line: the model should be spending its attention on
// judgment, not on transcribing paths without typos.

import { join } from 'node:path'

// One base allowance, plus a smaller one per additional check in the group. A grouped
// agent needs more reach than a solo one, but not N times more — the checks share a diff,
// a manifest, and usually the same handful of suspicious files.
function explorationBudget(checkCount) {
  return Math.min(10 + 5 * (checkCount - 1), 30)
}

const OUTPUT_FORMAT = `File format — if the check passes:

RESULT: PASS
One sentence why it passed.

If the check fails:

RESULT: FAIL
One sentence summary of what failed.

---

Finding: [title] | [file.ts] | [line] | [Severity] | [Type]
One or two sentences on what is wrong and why it matters.
Evidence:
- path/to/file.ts:42 — what is observably true at this location
- path/to/other.ts:88 — what is observably true here
Fix: One or two sentences on how to solve it.

\`\`\`diff
- old code
+ new code
\`\`\`

Rules:
- Start each file with \`RESULT: PASS\` or \`RESULT: FAIL\`, no markdown headers
- Severity: Error, Warning, or Info
- Type: Local (mechanical fix) or Design (broader change, new file, config wiring)
- \`Evidence:\` is REQUIRED and must cite concrete file:line observations. Every
  finding is independently verified against the repository, and anything that
  cannot be reproduced from its evidence is discarded. Evidence that only
  restates the claim will be dropped.
- Local fixes get a \`\`\`diff block; Design fixes get prose \`Fix:\` only
- Separate findings with \`---\`
- Do not assign confidence scores. Verification decides.`

export function renderReviewPrompt({ group, runDir, reviewRoot, base }) {
  const checks = group.checks
  const many = checks.length > 1
  const budget = explorationBudget(checks.length)

  const assignments = checks
    .map(
      (c) =>
        `- ${c.name}\n` +
        `    instructions: ${c.path}\n` +
        `    write result to: ${join(runDir, 'candidates', `${c.stem.replaceAll('/', '__')}.md`)}`
    )
    .join('\n')

  return `You are a code reviewer running ${many ? `${checks.length} automated checks` : 'one automated check'} against a set of changes.

## Context
Review root: ${reviewRoot}   — run all commands here
Base revision: ${base}

## Read first
1. ${join(runDir, 'manifest.md')}      — what changed; note which lines are moves, not behavior
2. ${join(runDir, 'diff.patch')}       — the change itself
3. ${join(runDir, 'evidence.md')}      — tool output; treat as established fact
4. ${join(runDir, 'neighborhood.md')}  — who references the changed code
5. ${join(runDir, 'log.txt')}          — commit log

## Your ${many ? 'checks' : 'check'}
${assignments}
${
  many
    ? `
Read all ${checks.length} sets of instructions first, then review once with all of them in
mind. Write one result file per check, at the exact paths above.

These checks own different concerns on purpose. Keep them separate in your output:
- A finding belongs in the file of the check whose instructions cover it, not wherever you
  noticed it. If two of your checks genuinely both cover it, report it in both — dedupe
  happens downstream and is not your job.
- Do not soften one check's conclusion because another check passed, and do not average
  them into a single moderate verdict. Each file stands alone.
`
    : ''
}
## Review rules
- Only review behavior introduced or changed by this diff.
- Do not flag pre-existing problems. To check whether something already existed:
  git -C ${reviewRoot} show "${base}:<path>"
  Brace the revision exactly as shown. In zsh, \`$BASE:path\` parses as the \`:a\`
  path modifier and silently mangles the argument into a bogus path — which then
  looks like "file not found" and can be misread as proof the code is new.
- Do not restate what an analyzer in evidence.md already reported.
- If you contradict a green analyzer, say why in your evidence.
- Lines the manifest marks as moves or reindents are not new behavior.

## Exploration budget
You MAY read repository files beyond the diff, up to ${budget} Read/Grep calls${many ? ' total, across all your checks' : ''}.
Start from neighborhood.md. Prefer one targeted grep over a broad search.
Never read files the manifest classes as generated.
Spend the budget confirming or killing a specific suspicion, not browsing.

## Output
Write ${many ? 'one file per check, at the paths listed above' : `your result to ${join(runDir, 'candidates', `${checks[0].stem.replaceAll('/', '__')}.md`)}`}.
Return only the single word DONE. Do not repeat your findings in your reply.

${OUTPUT_FORMAT}
`
}

const VERIFY_RUBRIC = `## Checks, in order — stop as soon as one is decisive
1. Does the cited file:line actually contain what the claim describes? Read it. If the
   location is wrong but the defect is real elsewhere in the diff, report the
   corrected location.
2. Did this already exist at the base revision?
   git -C {REVIEW_ROOT} show "{BASE}:<file>"
   Brace the revision exactly as shown — in zsh \`$BASE:path\` is parsed as the \`:a\`
   modifier and mangles the path, which reads as "file not found" and can be
   mistaken for proof that the code is new.
   If the same defect is present at base and the diff did not materially change
   that code, the verdict is REJECTED — pre-existing.
3. Is there a guard, validator, type constraint, or permission check elsewhere
   that already prevents it? Grep for it.
4. Is there already a test covering this behavior?
5. Is the behavior clearly intentional, given surrounding code or the commit log?`

function verdictBlock(runDir, id) {
  return `Write to ${join(runDir, 'verdicts', `${id}.txt`)}, exactly:

VERDICT: CONFIRMED | REJECTED | UNPROVEN
REASON: one sentence, citing what you checked
CORRECTED_LINE: <file>:<line>     (only if the original location was wrong)`
}

// One agent verifies a small batch. The separation that matters is that a verifier is
// never the agent that argued for the finding; the one-agent-per-finding ratio was
// incidental to that, and each spawn carries a fixed cost the batch amortizes.
export function renderVerifyPrompt({ findings, runDir, reviewRoot, base }) {
  const many = findings.length > 1

  const cases = findings
    .map(
      (f) =>
        `### Finding ${f.id}: ${f.title}\n` +
        `Location: ${f.file}${f.line ? `:${f.line}` : ''}\n` +
        `Flagged by: ${f.checks.join(', ')}\n` +
        `Claim: ${f.explanation || '(none given)'}\n` +
        `Claimed evidence:\n${(f.evidence.length ? f.evidence : ['(none given)']).map((e) => `- ${e}`).join('\n')}\n` +
        `Write your verdict to: ${join(runDir, 'verdicts', `${f.id}.txt`)}`
    )
    .join('\n\n')

  const rubric = VERIFY_RUBRIC.replaceAll('{REVIEW_ROOT}', reviewRoot).replaceAll('{BASE}', base)

  return `You are verifying ${many ? `${findings.length} code-review findings` : 'a single code-review finding'}. Assume ${many ? 'each one' : 'it'} is WRONG until the
repository proves otherwise. Your job is to refute, not to improve.

Review root: ${reviewRoot}
Base revision: ${base}

${many ? `Verify each finding independently. Evidence that settles one says nothing about
another — a real defect and a false positive routinely sit in the same file.\n` : ''}
## ${many ? 'Findings' : 'Finding'}

${cases}

${rubric}

Budget: up to ${many ? `${12 * findings.length} tool calls total, roughly 12 per finding` : '12 tool calls'}. If it runs out without a
decision, that is UNPROVEN, not CONFIRMED.

## Output
${
  many
    ? `Write one file per finding, at the paths listed above. Each contains exactly:

VERDICT: CONFIRMED | REJECTED | UNPROVEN
REASON: one sentence, citing what you checked
CORRECTED_LINE: <file>:<line>     (only if the original location was wrong)`
    : verdictBlock(runDir, findings[0].id)
}

CONFIRMED = reproduced from repository evidence, and introduced by this diff
REJECTED  = disproved, already guarded, intentional, or pre-existing
UNPROVEN  = could not establish either way within budget

Return only the single word DONE.
`
}

const VERIFY_BATCH_SIZE = 5

export function batch(items, size = VERIFY_BATCH_SIZE) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
