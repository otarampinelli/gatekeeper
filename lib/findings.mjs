import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SEVERITY_ORDER = { Error: 0, Warning: 1, Info: 2 }

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

// Deliberately excludes the line number. Lines shift as the user edits, and a dismissal
// that stops matching after an unrelated edit above it is worse than no dismissal at all.
export function fingerprint({ file, check, title }) {
  return createHash('sha1').update(`${file}|${check}|${slug(title)}`).digest('hex').slice(0, 12)
}

const RESULT = /^RESULT:\s*(PASS|FAIL)\s*$/im
const FINDING = /^Finding:\s*(.+)$/im

function normalizeSeverity(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v.startsWith('err')) return 'Error'
  if (v.startsWith('warn')) return 'Warning'
  if (v.startsWith('info')) return 'Info'
  return 'Warning'
}

function normalizeType(raw) {
  return String(raw ?? '').trim().toLowerCase().startsWith('local') ? 'Local' : 'Design'
}

// Parsing is deliberately lenient: agents drift on spacing, casing, and optional fields.
// A malformed finding is better degraded than dropped, so long as file and title survive.
function parseFinding(block, check) {
  const headMatch = FINDING.exec(block)
  if (!headMatch) return null
  const parts = headMatch[1].split('|').map((p) => p.trim())
  const [title, file, line, severity, type] = parts
  if (!title) return null

  const body = block.slice(headMatch.index + headMatch[0].length)
  const evidence = []
  const evidenceBlock = /Evidence:\s*\n((?:\s*[-*].*\n?)+)/i.exec(body)
  if (evidenceBlock) {
    for (const l of evidenceBlock[1].split('\n')) {
      const m = /^\s*[-*]\s*(.+)$/.exec(l)
      if (m) evidence.push(m[1].trim())
    }
  }

  const fixMatch = /^Fix:\s*(.+)$/im.exec(body)
  const diffMatch = /```diff\n([\s\S]*?)```/.exec(body)

  // Strip fenced blocks first: a diff body's `-`/`+` lines don't start with `- `, so they'd
  // survive the bullet filter and leak into the claim the verifier is asked to refute.
  const explanation = body
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((l) => l.trim() && !/^(Evidence:|Fix:|[-*]\s)/i.test(l.trim()))
    .join(' ')
    .trim()

  return {
    title,
    file: file || '(unknown)',
    line: Number.parseInt(line, 10) || null,
    severity: normalizeSeverity(severity),
    type: normalizeType(type),
    checks: [check],
    explanation,
    evidence,
    fix: fixMatch ? fixMatch[1].trim() : '',
    diff: diffMatch ? diffMatch[1].replace(/\n$/, '') : '',
  }
}

export function parseCandidateFile(text, check) {
  const result = RESULT.exec(text)
  const status = result ? result[1].toUpperCase() : text.includes('Finding:') ? 'FAIL' : 'PASS'
  const summaryLine = result
    ? (text.slice(result.index + result[0].length).split('\n').find((l) => l.trim()) ?? '').trim()
    : ''

  const findings = []
  if (status === 'FAIL') {
    for (const block of text.split(/^\s*---\s*$/m)) {
      const f = parseFinding(block, check)
      if (f) findings.push(f)
    }
  }
  return { check, status, summary: summaryLine, findings }
}

export function loadCandidates(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseCandidateFile(readFileSync(join(dir, f), 'utf8'), f.replace(/\.md$/, '').replaceAll('__', '/')))
}

// Exact structural dedup only: merging two genuinely different findings is worse than
// showing both, so anything less than an exact match is reported as a possible duplicate.
export function dedupe(reports) {
  const byKey = new Map()
  const all = reports.flatMap((r) => r.findings)

  for (const f of all) {
    const key = `${f.file}:${f.line ?? '?'}:${slug(f.title)}`
    const existing = byKey.get(key)
    if (existing) {
      for (const c of f.checks) if (!existing.checks.includes(c)) existing.checks.push(c)
      for (const e of f.evidence) if (!existing.evidence.includes(e)) existing.evidence.push(e)
      if (!existing.diff && f.diff) existing.diff = f.diff
      if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[existing.severity]) existing.severity = f.severity
    } else {
      byKey.set(key, { ...f })
    }
  }

  const merged = [...byKey.values()]
  const locationGroups = new Map()
  for (const f of merged) {
    const loc = `${f.file}:${f.line ?? '?'}`
    if (!locationGroups.has(loc)) locationGroups.set(loc, [])
    locationGroups.get(loc).push(f.title)
  }
  const possibleDuplicates = [...locationGroups.entries()]
    .filter(([, titles]) => titles.length > 1)
    .map(([loc, titles]) => ({ location: loc, titles }))

  return { findings: merged, possibleDuplicates }
}

export function assignIds(findings) {
  return findings.map((f, i) => ({
    ...f,
    id: `F${String(i + 1).padStart(2, '0')}`,
    fingerprint: fingerprint({ file: f.file, check: f.checks[0], title: f.title }),
  }))
}

const VERDICT = /^VERDICT:\s*(CONFIRMED|REJECTED|UNPROVEN)/im
const REASON = /^REASON:\s*(.+)$/im
const CORRECTED = /^CORRECTED_LINE:\s*(.+)$/im

export function parseVerdict(text) {
  const v = VERDICT.exec(text)
  const r = REASON.exec(text)
  const c = CORRECTED.exec(text)
  return {
    // An unparseable verdict is UNPROVEN, never CONFIRMED. A verification layer that
    // fails open is strictly worse than no verification layer.
    verdict: v ? v[1].toUpperCase() : 'UNPROVEN',
    reason: r ? r[1].trim() : 'verifier returned no parseable verdict',
    correctedLine: c ? c[1].trim() : null,
  }
}

export function loadVerdicts(dir) {
  if (!existsSync(dir)) return {}
  const out = {}
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.txt') || x.endsWith('.md'))) {
    out[f.replace(/\.(txt|md)$/, '')] = parseVerdict(readFileSync(join(dir, f), 'utf8'))
  }
  return out
}

export function loadDismissals(stateDir) {
  const path = join(stateDir, 'dismissals.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {} // malformed state is empty state; it must never break a review
  }
}

export function recordDismissal(stateDir, finding, today) {
  const path = join(stateDir, 'dismissals.json')
  const all = loadDismissals(stateDir)
  all[finding.fingerprint] = {
    title: finding.title,
    file: finding.file,
    checks: finding.checks,
    dismissedOn: today,
  }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(path, JSON.stringify(all, null, 2))
  return all
}

export function rank({ findings, verdicts, dismissals, fresh, verifySkipped }) {
  const reported = []
  const suppressed = { rejected: 0, unproven: 0, dismissed: 0 }

  for (const f of findings) {
    const v = verdicts[f.id] ?? null
    const verdict = verifySkipped ? 'UNVERIFIED' : (v?.verdict ?? 'UNPROVEN')
    const reason = v?.reason ?? (verifySkipped ? 'verification skipped' : '')

    if (!fresh && dismissals[f.fingerprint]) {
      suppressed.dismissed++
      continue
    }
    if (verdict === 'REJECTED') {
      suppressed.rejected++
      continue
    }
    if (verdict === 'UNPROVEN' && f.severity !== 'Error') {
      suppressed.unproven++
      continue
    }

    const line = v?.correctedLine ? Number.parseInt(v.correctedLine.split(':').pop(), 10) || f.line : f.line
    reported.push({ ...f, line, verdict, verdictReason: reason })
  }

  reported.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.evidence.length - a.evidence.length ||
      a.file.localeCompare(b.file)
  )

  return { reported, suppressed }
}

const EMOJI = { Error: '🔴', Warning: '🟡', Info: '🔵' }

export function renderSummary({ reports, reported, suppressed, gatedOut, evidence, churn, possibleDuplicates, verifySkipped }) {
  const L = []
  const passed = reports.filter((r) => r.status === 'PASS')
  L.push(`🛡️  Gatekeeper — ${reports.length} checks run, ${gatedOut} gated out`, '')
  L.push('| Finding | Verdict | Flagged by |', '|---|---|---|')

  for (const f of reported) {
    const loc = `${f.file}${f.line ? `:${f.line}` : ''}`
    L.push(`| ${EMOJI[f.severity]} ${f.title} — ${loc} | ${f.verdict.toLowerCase()} | ${f.checks.join(', ')} |`)
  }
  for (const r of passed) L.push(`| ✅ ${r.check} — passed | | ${r.check} |`)
  L.push('')
  L.push(`${reported.length} finding(s) across ${reports.length} checks.`)

  const parts = []
  if (suppressed.rejected) parts.push(`${suppressed.rejected} rejected by verification`)
  if (suppressed.unproven) parts.push(`${suppressed.unproven} unproven`)
  if (suppressed.dismissed) parts.push(`${suppressed.dismissed} previously dismissed`)
  if (parts.length) L.push(`Suppressed: ${parts.join(', ')}.`)
  if (verifySkipped) L.push('Verification was SKIPPED (--no-verify): findings are unverified.')

  if (evidence?.length) {
    L.push(`Evidence: ${evidence.map((e) => `${e.name} ${e.status}`).join(', ')}.`)
  }
  if (churn?.identical > 0) {
    const total = churn.added + churn.removed
    L.push(`Churn: ~${churn.identical} of ${total} changed lines are moves, not new behavior.`)
  }
  if (possibleDuplicates?.length) {
    L.push('')
    L.push('Possible duplicates to merge before triage:')
    for (const d of possibleDuplicates) L.push(`  ${d.location}: ${d.titles.join(' | ')}`)
  }
  return L.join('\n')
}
