//   node --test .gatekeeper/test/

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { churn } from '../lib/manifest.mjs'
import { parseFrontmatter, groupChecks } from '../lib/policy.mjs'
import { batch } from '../lib/prompts.mjs'
import { parseCandidateFile, parseVerdict, rank, fingerprint } from '../lib/findings.mjs'

// --------------------------------------------------------------------------- churn

test('churn counts content present on both sides as a move', () => {
  const patch = ['--- a/x.ts', '+++ b/x.ts', '-const a = 1', '-const b = 2', '+const a = 1', '+const b = 2'].join('\n')
  assert.deepEqual(churn(patch), { added: 2, removed: 2, identical: 2 })
})

test('churn treats a reindent as a move, not new behavior', () => {
  const patch = ['--- a/x.ts', '+++ b/x.ts', '-  return 1', '+      return 1'].join('\n')
  assert.equal(churn(patch).identical, 1)
})

test('churn does not count file headers as changed lines', () => {
  const patch = ['--- a/x.ts', '+++ b/x.ts', '+new line'].join('\n')
  assert.deepEqual(churn(patch), { added: 1, removed: 0, identical: 0 })
})

test('churn counts a real rewrite as no move at all', () => {
  const patch = ['--- a/x.ts', '+++ b/x.ts', '-const a = 1', '+const a = 2'].join('\n')
  assert.equal(churn(patch).identical, 0)
})

test('churn matches a moved line only once per occurrence', () => {
  const patch = ['--- a/x.ts', '+++ b/x.ts', '-dup', '+dup', '+dup'].join('\n')
  assert.deepEqual(churn(patch), { added: 2, removed: 1, identical: 1 })
})

// --------------------------------------------------------------- candidate parsing

test('parseCandidateFile reads a passing check', () => {
  const r = parseCandidateFile('RESULT: PASS\nNothing to flag here.\n', 'simplicity')
  assert.equal(r.status, 'PASS')
  assert.equal(r.summary, 'Nothing to flag here.')
  assert.deepEqual(r.findings, [])
})

test('parseCandidateFile reads a full finding', () => {
  const text = [
    'RESULT: FAIL',
    'One thing is wrong.',
    '',
    '---',
    '',
    'Finding: Hardcoded password | app.module.ts | 925 | Error | Local',
    'The password is committed in source instead of read from the environment.',
    'Evidence:',
    '- app.module.ts:925 — passes a literal string',
    '- app.module.ts:1 — no env import in this module',
    'Fix: Read it from process.env.',
    '',
    '```diff',
    "-  password: '123',",
    '+  password: process.env.PG_PASSWORD,',
    '```',
  ].join('\n')

  const r = parseCandidateFile(text, 'security-review')
  assert.equal(r.status, 'FAIL')
  assert.equal(r.findings.length, 1)

  const f = r.findings[0]
  assert.equal(f.title, 'Hardcoded password')
  assert.equal(f.file, 'app.module.ts')
  assert.equal(f.line, 925)
  assert.equal(f.severity, 'Error')
  assert.equal(f.type, 'Local')
  assert.deepEqual(f.checks, ['security-review'])
  assert.equal(f.evidence.length, 2)
  assert.match(f.evidence[0], /passes a literal string/)
  assert.equal(f.fix, 'Read it from process.env.')
  assert.match(f.diff, /process\.env\.PG_PASSWORD/)
  assert.match(f.explanation, /committed in source/)
})

test('parseCandidateFile keeps the proposed diff out of the claim', () => {
  const text = [
    'RESULT: FAIL',
    'summary',
    '---',
    'Finding: Pass-through wrapper | a.ts | 12 | Warning | Local',
    'The helper only forwards its argument.',
    'Evidence:',
    '- a.ts:12 — returns the call unchanged',
    'Fix: Inline it.',
    '',
    '```diff',
    '-function wrap(x) { return inner(x) }',
    '+// call inner directly',
    '```',
  ].join('\n')

  // The explanation is what a verifier is asked to refute, so diff body lines — which do
  // not start with "- " and so survive the bullet filter — must not leak into it.
  const [f] = parseCandidateFile(text, 'simplicity').findings
  assert.equal(f.explanation, 'The helper only forwards its argument.')
  assert.match(f.diff, /call inner directly/)
})

test('parseCandidateFile splits multiple findings on ---', () => {
  const text = [
    'RESULT: FAIL',
    'Two problems.',
    '---',
    'Finding: First | a.ts | 1 | Warning | Local',
    'Evidence:',
    '- a.ts:1 — something',
    '---',
    'Finding: Second | b.ts | 2 | Info | Design',
    'Evidence:',
    '- b.ts:2 — something else',
  ].join('\n')

  const r = parseCandidateFile(text, 'code-quality')
  assert.deepEqual(r.findings.map((f) => f.title), ['First', 'Second'])
})

test('parseCandidateFile degrades a malformed finding rather than dropping it', () => {
  const r = parseCandidateFile('RESULT: FAIL\nbroken\n---\nFinding: No fields at all\n', 'anti-slop')
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].title, 'No fields at all')
  assert.equal(r.findings[0].file, '(unknown)')
  assert.equal(r.findings[0].line, null)
  // An unlabelled severity must not silently become the lowest one.
  assert.equal(r.findings[0].severity, 'Warning')
  assert.equal(r.findings[0].type, 'Design')
})

test('parseCandidateFile infers FAIL when the RESULT line is missing but a finding is not', () => {
  const r = parseCandidateFile('Finding: Untagged | a.ts | 3 | Error | Local\n', 'simplicity')
  assert.equal(r.status, 'FAIL')
  assert.equal(r.findings.length, 1)
})

// ------------------------------------------------------------------ verdict parsing

test('parseVerdict reads each verdict and its reason', () => {
  for (const v of ['CONFIRMED', 'REJECTED', 'UNPROVEN']) {
    const p = parseVerdict(`VERDICT: ${v}\nREASON: because I checked the base revision\n`)
    assert.equal(p.verdict, v)
    assert.equal(p.reason, 'because I checked the base revision')
  }
})

test('parseVerdict fails closed on unparseable output', () => {
  for (const text of ['', 'the finding looks correct to me', 'VERDICT: PROBABLY', 'CONFIRMED']) {
    assert.equal(parseVerdict(text).verdict, 'UNPROVEN', `should not trust: ${JSON.stringify(text)}`)
  }
})

test('parseVerdict picks up a corrected location', () => {
  const p = parseVerdict('VERDICT: CONFIRMED\nREASON: real, but one line down\nCORRECTED_LINE: app.ts:44\n')
  assert.equal(p.correctedLine, 'app.ts:44')
})

// ------------------------------------------------------------------ reporting gate

function finding(over = {}) {
  return {
    id: 'F01',
    fingerprint: 'fp-f01',
    title: 'Something',
    file: 'a.ts',
    line: 10,
    severity: 'Error',
    type: 'Local',
    checks: ['code-quality'],
    evidence: ['a.ts:10 — observed'],
    ...over,
  }
}

const gate = [
  ['CONFIRMED', 'Error', true],
  ['CONFIRMED', 'Warning', true],
  ['CONFIRMED', 'Info', true],
  ['UNPROVEN', 'Error', true],
  ['UNPROVEN', 'Warning', false],
  ['UNPROVEN', 'Info', false],
  ['REJECTED', 'Error', false],
  ['REJECTED', 'Warning', false],
]

for (const [verdict, severity, expected] of gate) {
  test(`rank: ${verdict} ${severity} is ${expected ? 'reported' : 'suppressed'}`, () => {
    const { reported } = rank({
      findings: [finding({ severity })],
      verdicts: { F01: { verdict, reason: 'r' } },
      dismissals: {},
      fresh: false,
      verifySkipped: false,
    })
    assert.equal(reported.length, expected ? 1 : 0)
  })
}

test('rank treats a missing verdict as UNPROVEN, not as confirmed', () => {
  const { reported, suppressed } = rank({
    findings: [finding({ severity: 'Warning' })],
    verdicts: {},
    dismissals: {},
    fresh: false,
    verifySkipped: false,
  })
  assert.equal(reported.length, 0)
  assert.equal(suppressed.unproven, 1)
})

test('rank suppresses a dismissed finding, and --fresh overrides that', () => {
  const args = {
    findings: [finding()],
    verdicts: { F01: { verdict: 'CONFIRMED', reason: 'r' } },
    dismissals: { 'fp-f01': { dismissedOn: '2026-08-01' } },
    verifySkipped: false,
  }
  assert.equal(rank({ ...args, fresh: false }).reported.length, 0)
  assert.equal(rank({ ...args, fresh: false }).suppressed.dismissed, 1)
  assert.equal(rank({ ...args, fresh: true }).reported.length, 1)
})

test('rank counts every suppression it makes', () => {
  const { reported, suppressed } = rank({
    findings: [
      finding({ id: 'F01', fingerprint: 'a', severity: 'Error' }),
      finding({ id: 'F02', fingerprint: 'b', severity: 'Warning' }),
      finding({ id: 'F03', fingerprint: 'c', severity: 'Error' }),
      finding({ id: 'F04', fingerprint: 'd', severity: 'Error' }),
    ],
    verdicts: {
      F01: { verdict: 'CONFIRMED', reason: 'r' },
      F02: { verdict: 'UNPROVEN', reason: 'r' },
      F03: { verdict: 'REJECTED', reason: 'r' },
      F04: { verdict: 'CONFIRMED', reason: 'r' },
    },
    dismissals: { d: { dismissedOn: '2026-08-01' } },
    fresh: false,
    verifySkipped: false,
  })
  assert.equal(reported.length, 1)
  assert.deepEqual(suppressed, { rejected: 1, unproven: 1, dismissed: 1 })
})

test('rank applies a verifier-corrected line', () => {
  const { reported } = rank({
    findings: [finding()],
    verdicts: { F01: { verdict: 'CONFIRMED', reason: 'r', correctedLine: 'a.ts:44' } },
    dismissals: {},
    fresh: false,
    verifySkipped: false,
  })
  assert.equal(reported[0].line, 44)
})

test('rank orders errors above warnings', () => {
  const { reported } = rank({
    findings: [
      finding({ id: 'F01', fingerprint: 'a', severity: 'Warning' }),
      finding({ id: 'F02', fingerprint: 'b', severity: 'Error' }),
    ],
    verdicts: {
      F01: { verdict: 'CONFIRMED', reason: 'r' },
      F02: { verdict: 'CONFIRMED', reason: 'r' },
    },
    dismissals: {},
    fresh: false,
    verifySkipped: false,
  })
  assert.deepEqual(reported.map((f) => f.id), ['F02', 'F01'])
})

test('rank labels everything UNVERIFIED when verification was skipped', () => {
  const { reported } = rank({
    findings: [finding()],
    verdicts: {},
    dismissals: {},
    fresh: false,
    verifySkipped: true,
  })
  assert.equal(reported.length, 1)
  assert.equal(reported[0].verdict, 'UNVERIFIED')
})

// --------------------------------------------------------------------- fingerprints

test('fingerprint ignores the line number so an edit above a finding does not reopen it', () => {
  const a = fingerprint({ file: 'a.ts', check: 'code-quality', title: 'Magic number' })
  const b = fingerprint({ file: 'a.ts', check: 'code-quality', title: 'Magic number' })
  assert.equal(a, b)
})

test('fingerprint is insensitive to title punctuation and case, sensitive to its words', () => {
  const base = fingerprint({ file: 'a.ts', check: 'c', title: 'Magic number' })
  assert.equal(base, fingerprint({ file: 'a.ts', check: 'c', title: 'magic  number!' }))
  assert.notEqual(base, fingerprint({ file: 'a.ts', check: 'c', title: 'Magic numbers' }))
})

test('fingerprint separates findings by file and by check', () => {
  const base = fingerprint({ file: 'a.ts', check: 'c', title: 't' })
  assert.notEqual(base, fingerprint({ file: 'b.ts', check: 'c', title: 't' }))
  assert.notEqual(base, fingerprint({ file: 'a.ts', check: 'd', title: 't' }))
})

// ------------------------------------------------------------------- frontmatter

test('parseFrontmatter reads scalars and lists', () => {
  const fm = parseFrontmatter(
    [
      '---',
      'name: Convex Migrations',
      'description: Flag migrations that are unregistered, non-idempotent, or wrong',
      'group: convex-schema',
      'applies_to:',
      '  - "convex/**"',
      '  - "apps/**/*.ts"',
      'hints:',
      '  - new file under convex/src/migrations/',
      '  - migrations.define / migrateOne changes',
      '---',
      '',
      '# Body starts here',
      'group: not-frontmatter',
    ].join('\n')
  )
  assert.equal(fm.name, 'Convex Migrations')
  assert.equal(fm.description, 'Flag migrations that are unregistered, non-idempotent, or wrong')
  assert.equal(fm.group, 'convex-schema')
  assert.deepEqual(fm.applies_to, ['convex/**', 'apps/**/*.ts'])
  assert.equal(fm.hints.length, 2)
  assert.equal(fm.hints[1], 'migrations.define / migrateOne changes')
})

test('parseFrontmatter returns nothing when there is no frontmatter to read', () => {
  assert.deepEqual(parseFrontmatter('# Just a heading\n'), {})
  assert.deepEqual(parseFrontmatter('---\nname: unterminated\n'), {})
  assert.deepEqual(parseFrontmatter(''), {})
})

test('parseFrontmatter skips comments and keeps a value containing a colon', () => {
  const fm = parseFrontmatter(['---', '# a comment', 'description: Flag this: and that', '---'].join('\n'))
  assert.equal(fm.description, 'Flag this: and that')
})

// ----------------------------------------------------------------------- grouping

function check(stem, group, bytes = 1000) {
  return { stem, group: group ?? stem, bytes, path: `/checks/${stem}.md`, name: stem }
}

test('groupChecks puts one agent on each declared group', () => {
  const groups = groupChecks([
    check('anti-slop', 'quality'),
    check('simplicity', 'quality'),
    check('test-coverage', 'reach'),
  ])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].checks.map((c) => c.stem), ['anti-slop', 'simplicity'])
  assert.equal(groups[0].id, 'quality')
  assert.deepEqual(groups[1].checks.map((c) => c.stem), ['test-coverage'])
})

test('groupChecks gives an ungrouped check its own agent', () => {
  const groups = groupChecks([check('security-review'), check('prose-style')])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((g) => g.id), ['security-review', 'prose-style'])
})

test('groupChecks splits a group whose combined instructions exceed the cap', () => {
  const groups = groupChecks(
    [check('a', 'big', 900), check('b', 'big', 900), check('c', 'big', 900)],
    2000
  )
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((g) => g.id), ['big-1', 'big-2'])
  assert.deepEqual(groups[0].checks.map((c) => c.stem), ['a', 'b'])
  assert.deepEqual(groups[1].checks.map((c) => c.stem), ['c'])
})

test('groupChecks never drops a check that is bigger than the cap on its own', () => {
  const groups = groupChecks([check('huge', 'g', 99999)], 2000)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].checks.map((c) => c.stem), ['huge'])
})

test('groupChecks keeps a directory separator out of the prompt filename', () => {
  const [group] = groupChecks([check('convex/migrations')])
  assert.equal(group.id, 'convex/migrations')
  assert.equal(group.fileId, 'convex__migrations')
})

test('groupChecks reports the combined byte weight of each agent', () => {
  const [group] = groupChecks([check('a', 'g', 100), check('b', 'g', 250)])
  assert.equal(group.bytes, 350)
})

// ------------------------------------------------------------------------ batching

test('batch splits findings into verifier-sized groups and loses none', () => {
  const ids = Array.from({ length: 12 }, (_, i) => i + 1)
  const groups = batch(ids, 5)
  assert.deepEqual(groups.map((g) => g.length), [5, 5, 2])
  assert.deepEqual(groups.flat(), ids)
})

test('batch of nothing is nothing', () => {
  assert.deepEqual(batch([], 5), [])
})
