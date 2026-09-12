import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitLines, blobHash, gh } from './git.mjs'
import { toPathspec } from './policy.mjs'

const TAIL_LINES = 40
// A tool's own verdict ("55 problems", "Tests: 3 failed") lives in its last few lines and
// names no file, so it would not survive relevance filtering on its own.
const CODA_LINES = 5

function tail(text, n = TAIL_LINES) {
  const lines = text.split('\n').filter((l) => l !== '')
  return lines.length <= n ? lines.join('\n') : [`... (${lines.length - n} earlier lines omitted)`, ...lines.slice(-n)].join('\n')
}

// A plain tail of a whole-app lint run evicts the few lines naming files under review.
// Keep those lines instead, so analyzers don't need per-file invocation to fit the window.
function relevantTail(text, files, n = TAIL_LINES) {
  const lines = text.split('\n').filter((l) => l !== '')
  if (lines.length <= n) return lines.join('\n')
  if (!files?.length) return tail(text, n)

  // Tools print paths relative to their invocation dir, not always the review root:
  // match basename too, accepting an occasional false positive over dropping a real hit.
  const needles = [...new Set(files.flatMap((f) => [f, f.split('/').pop()]))].filter(Boolean)
  const hits = []
  for (let i = 0; i < lines.length; i += 1) {
    if (needles.some((s) => lines[i].includes(s))) hits.push(i)
  }
  if (!hits.length) return tail(text, n)

  const keep = new Set(hits.slice(-n))
  for (let i = Math.max(0, lines.length - CODA_LINES); i < lines.length; i += 1) keep.add(i)

  const out = []
  let prev = -1
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > prev + 1) out.push(`... (${i - prev - 1} line(s) omitted)`)
    out.push(lines[i])
    prev = i
  }
  return out.join('\n')
}

function matchedFiles({ cwd, base, head, when }) {
  if (!Array.isArray(when) || !when.length) return []
  const range = head ? [base, head] : [base]
  return gitLines(['diff', '--name-only', ...range, '--', ...toPathspec(when)], { cwd, allowFail: true })
}

// Key on the analyzer's input files and their hashes, not the whole diff, so an unrelated
// edit doesn't invalidate every cache entry on the next keystroke.
function cacheKey(name, files, cwd) {
  const h = createHash('sha1')
  h.update(name)
  for (const f of [...files].sort()) h.update(`\n${f}:${blobHash(f, cwd)}`)
  return h.digest('hex').slice(0, 16)
}

// POSIX single-quote escape: close, insert an escaped quote, reopen. Needed because
// `{{changed_files}}` can carry attacker-chosen names in PR mode.
function shellQuote(s) {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

function runOne(analyzer, { cwd, base, head, deep, cacheDir, hasNodeModules, ciAvailable }) {
  const name = analyzer.name ?? '(unnamed)'
  const files = matchedFiles({ cwd, base, head, when: analyzer.when })

  if (!files.length) return { name, status: 'skipped', reason: 'no changed file matches `when`' }
  if (analyzer.deep === true && !deep) {
    return { name, status: 'skipped', reason: 'deep-only (pass --deep to enable)' }
  }

  // `files` narrows {{changed_files}} without narrowing eligibility: a .vue/.css-only
  // tool shouldn't be handed a .ts path and report parse errors as findings.
  const subject = Array.isArray(analyzer.files) && analyzer.files.length
    ? matchedFiles({ cwd, base, head, when: analyzer.files })
    : files
  if (!subject.length) return { name, status: 'skipped', reason: 'no changed file matches `files`' }

  if (analyzer.needsInstall === true && !hasNodeModules) {
    // Name the covering source when there is one. A skip that reads as a hole and a skip
    // that reads as "CI already answered this" lead a reviewer to opposite conclusions.
    return {
      name,
      status: 'skipped',
      reason: ciAvailable
        ? 'needs an install this review does not do — see the CI section for this commit'
        : 'needsInstall and the review root has no node_modules',
    }
  }
  if (!analyzer.run) return { name, status: 'skipped', reason: 'no `run` command' }

  const key = cacheKey(name, subject, cwd)
  const cachePath = join(cacheDir, `${name}-${key}.json`)
  if (existsSync(cachePath)) {
    try {
      return { ...JSON.parse(readFileSync(cachePath, 'utf8')), cached: true }
    } catch {}
  }

  const cmd = String(analyzer.run)
    .replaceAll('{{base}}', base)
    .replaceAll('{{review_root}}', cwd)
    .replaceAll('{{changed_files}}', subject.map(shellQuote).join(' '))

  const timeoutMs = (Number(analyzer.timeout) || 120) * 1000
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })

  let status
  let reason = ''
  if (res.error && res.error.code === 'ETIMEDOUT') {
    status = 'timeout'
    reason = `exceeded ${analyzer.timeout}s`
  } else if (res.error) {
    status = 'error'
    reason = String(res.error.message)
  } else if (res.status === 0) {
    status = 'ok'
  } else {
    status = analyzer.expect === 'report' ? 'reported' : 'failed'
    reason = `exit ${res.status}`
  }

  const output = relevantTail(`${res.stdout ?? ''}${res.stderr ?? ''}`, subject)
  const result = {
    name,
    status,
    reason,
    exit: res.status ?? null,
    expect: analyzer.expect ?? 'report',
    inputs: subject.length,
    // A tool that selected nothing to do also exits 0. Surfacing this stops "exit 0"
    // from being read as "the suite passed".
    didWork: output.trim().length > 0,
    output,
  }

  if (status !== 'timeout' && status !== 'error') {
    try {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(cachePath, JSON.stringify(result))
    } catch {
      // caching is best-effort, not required
    }
  }
  return result
}

export function runAnalyzers({ analyzers, cwd, base, head, deep, cacheDir, ciAvailable = false }) {
  const hasNodeModules = existsSync(join(cwd, 'node_modules'))
  return analyzers.map((a) => {
    try {
      return runOne(a, { cwd, base, head, deep, cacheDir, hasNodeModules, ciAvailable })
    } catch (err) {
      // A broken analyzer should degrade the evidence, not abort the whole review.
      return { name: a.name ?? '(unnamed)', status: 'error', reason: String(err.message) }
    }
  })
}

// Reusing CI results avoids repeating an install this engine deliberately skips locally.
// Anchored to headSha, not the PR number, so a stale run from an earlier push isn't read as current.
const CI_STATUS = {
  success: 'ok',
  failure: 'failed',
  timed_out: 'failed',
  cancelled: 'skipped',
  skipped: 'skipped',
  neutral: 'reported',
  stale: 'reported',
  action_required: 'reported',
}

// Cap log fetches: a board with many failing jobs shouldn't cost one API call each.
const MAX_LOG_FETCHES = 8

// Actions logs end with the post-job cleanup steps, so a plain tail reliably shows
// teardown noise instead of the failure. The runner marks the real thing with `##[error]`.
function failureExcerpt(log) {
  const lines = log.split('\n').map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, '')).filter((l) => l !== '')
  const last = lines.findLastIndex((l) => l.includes('##[error]'))
  if (last === -1) return tail(lines.join('\n'))
  const start = Math.max(0, last - TAIL_LINES)
  const window = lines.slice(start, last + 1)
  return (start > 0 ? [`... (${start} earlier lines omitted)`, ...window] : window).join('\n')
}

export async function fetchCiEvidence({ cwd, headSha, baseRef, defaultBranch }) {
  if (!headSha) return { available: false, runs: [], reason: 'this run has no head commit' }

  // Workflows gated to the default branch never fire for a stacked PR, so its board looks
  // thinner, not green: say that explicitly rather than let the absence of red pass as a pass.
  const note =
    baseRef && defaultBranch && baseRef !== defaultBranch
      ? `This PR targets \`${baseRef}\`, not \`${defaultBranch}\`. Workflows gated to the default ` +
        'branch never fired, so this board is expected to be far thinner than a normal PR. Judge it ' +
        'by which jobs are present, not by the absence of red.'
      : null

  // `gh` expands {owner}/{repo} from the local remote, so there is no URL to parse.
  const res = await gh(
    [
      'api',
      '--paginate',
      `repos/{owner}/{repo}/commits/${headSha}/check-runs`,
      '--jq',
      '.check_runs[] | {name, status, conclusion, details_url}',
    ],
    { cwd }
  )
  if (!res.ok) {
    const detail = res.stderr.trim().split('\n').pop() || 'unknown error'
    return { available: false, runs: [], reason: `gh api failed: ${detail}` }
  }

  const runs = []
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      runs.push(JSON.parse(line))
    } catch {
      // Lose one malformed row rather than the whole board.
    }
  }
  if (!runs.length) return { available: true, runs: [], note, reason: 'no check runs are attached to this commit' }

  const results = runs.map((r) => {
    const completed = r.status === 'completed'
    const status = completed ? (CI_STATUS[r.conclusion] ?? 'reported') : 'skipped'
    return {
      name: r.name,
      status,
      conclusion: r.conclusion ?? null,
      reason: completed ? (status === 'skipped' ? `CI reported ${r.conclusion}` : '') : `still running (${r.status})`,
      url: r.details_url ?? null,
    }
  })

  let fetched = 0
  for (const r of results) {
    if (r.status !== 'failed') continue
    if (fetched >= MAX_LOG_FETCHES) {
      r.reason = 'log not fetched — too many failing jobs'
      continue
    }
    fetched += 1
    const jobId = /\/job\/(\d+)/.exec(r.url ?? '')?.[1]
    if (!jobId) continue
    const log = await gh(['api', `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`], { cwd, timeout: 120_000 })
    if (log.ok && log.stdout.trim()) r.output = failureExcerpt(log.stdout)
  }

  return { available: true, runs: results, note }
}

const HEADING = {
  ok: 'PASS',
  failed: 'FAIL',
  reported: 'findings',
  skipped: 'skipped',
  timeout: 'timed out',
  error: 'error',
}

function renderCi(ci) {
  const L = ['## Continuous integration', '']
  if (!ci.available) {
    L.push(`CI evidence unavailable: ${ci.reason}.`, '')
    return L
  }
  if (ci.note) L.push(`**${ci.note}**`, '')
  if (!ci.runs.length) {
    L.push(
      `**No CI evidence** — ${ci.reason}.`,
      'Nothing here establishes that this branch builds, typechecks, or passes its tests.',
      'Treat that as unknown, never as a pass.',
      ''
    )
    return L
  }

  const tally = {}
  for (const r of ci.runs) tally[r.status] = (tally[r.status] ?? 0) + 1
  L.push(
    `${ci.runs.length} check run(s) attached to the reviewed commit — ${Object.entries(tally)
      .map(([k, v]) => `${v} ${HEADING[k] ?? k}`)
      .join(', ')}.`,
    'Every one ran against this exact commit. A job absent from this list did not run:',
    'that is unknown, not passing.',
    ''
  )
  for (const r of ci.runs) L.push(`- **${HEADING[r.status] ?? r.status}** — ${r.name}${r.reason ? ` (${r.reason})` : ''}`)
  L.push('')
  for (const r of ci.runs) {
    if (!r.output) continue
    L.push(`### ${r.name} — failing output`, '', '```', r.output, '```', '')
  }
  return L
}

export function renderEvidence(results, { policyPresent, ci = null }) {
  const L = ['# Deterministic Evidence', '']
  if (!policyPresent && !ci) {
    L.push('No `.gatekeeper/analyzers.mjs` found — no deterministic evidence available.', '')
    return L.join('\n')
  }
  L.push(
    'These are established facts. Do not re-derive them, and do not restate them as findings.',
    'If a finding contradicts a green analyzer or a green CI job, it must explain why.',
    ''
  )
  if (ci) L.push(...renderCi(ci))

  L.push('## Local analyzers', '')
  if (!policyPresent) {
    L.push('No `.gatekeeper/analyzers.mjs` found — no local analyzer evidence.', '')
    return L.join('\n')
  }
  for (const r of results) {
    const head = `### ${r.name} — ${HEADING[r.status] ?? r.status}${r.exit != null && r.status === 'failed' ? ` (exit ${r.exit})` : ''}${r.cached ? ' [cached]' : ''}`
    L.push(head)
    if (r.reason) L.push(r.reason)
    if (r.status !== 'skipped' && !r.didWork) {
      L.push('Command produced no output — it may have selected no work. This is not a pass.')
    }
    if (r.output) L.push('', '```', r.output, '```')
    L.push('')
  }
  return L.join('\n')
}
