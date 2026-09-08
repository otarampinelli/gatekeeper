#!/usr/bin/env node
// Gatekeeper deterministic engine.
//
// Every subcommand prints a compact JSON result to stdout and writes bulk artifacts to
// disk. That split is the point: the orchestrating model reads a few lines instead of
// pulling manifests, analyzer logs, and review text through its context.
//
// Judgment stays with the model — intent inference, the reviews themselves, verification
// reasoning, and triage. This engine only does work that has one correct answer, which
// includes filling in the agent prompts.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  commonGitDir,
  repoRoot,
  resolveLocalBase,
  addWorktree,
  removeWorktree,
  git,
  defaultBranchRef,
} from '../lib/git.mjs'
import { loadPolicy, loadChecks, groupChecks, toPathspec } from '../lib/policy.mjs'
import { buildManifest, renderManifest, captureLog } from '../lib/manifest.mjs'
import { runAnalyzers, renderEvidence, fetchCiEvidence } from '../lib/analyzers.mjs'
import { buildNeighborhood, renderNeighborhood } from '../lib/neighborhood.mjs'
import { renderReviewPrompt, renderVerifyPrompt, batch } from '../lib/prompts.mjs'
import {
  loadCandidates,
  dedupe,
  assignIds,
  loadVerdicts,
  loadDismissals,
  recordDismissal,
  rank,
  renderSummary,
} from '../lib/findings.mjs'

// Above this the full check set is too expensive to select by default. The engine reports
// the fact; the skill is what refuses. A repo-wide sweep touches every gated path, so
// gating cannot help and only a named subset can.
const WIDE_PATCH_TOKENS = 20000

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`)
}

function fail(message, extra = {}) {
  out({ ok: false, error: message, ...extra })
  process.exit(1)
}

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      if (v !== undefined) flags[k] = v
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
      else flags[k] = true
    } else positional.push(a)
  }
  return { flags, positional }
}

function stateRoot(cwd) {
  return join(commonGitDir(cwd), 'gatekeeper')
}

function runMeta(runDir) {
  const path = join(runDir, 'run.json')
  if (!existsSync(path)) fail(`no run.json in ${runDir} — run \`gk prepare\` first`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeRunMeta(runDir, meta) {
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(meta, null, 2))
}

async function cmdPrepare(flags) {
  const root = repoRoot()
  const policy = await loadPolicy(root)

  let mode = 'local'
  let reviewRoot = root
  let head = null
  let prNumber = null
  let worktree = null
  let base
  let baseHow
  let prMeta = null

  if (flags.pr) {
    if (!spawnSyncOk('gh', ['--version'])) fail('the GitHub CLI (gh) is not installed')
    if (!spawnSyncOk('gh', ['auth', 'status'])) fail('gh is not authenticated — run `gh auth login`')

    const view = spawnSync(
      'gh',
      ['pr', 'view', String(flags.pr), '--json', 'number,headRefOid,baseRefName,title,body,url'],
      { encoding: 'utf8', cwd: root }
    )
    if (view.status !== 0) fail(`cannot read PR: ${(view.stderr || '').trim()}`)
    prMeta = JSON.parse(view.stdout)
    prNumber = prMeta.number
    mode = 'pr'

    git(['fetch', 'origin', `pull/${prNumber}/head`], { cwd: root })

    worktree = join(stateRoot(root), 'worktrees', `pr-${prNumber}`)
    if (existsSync(worktree)) removeWorktree(worktree, root)
    mkdirSync(dirname(worktree), { recursive: true })
    addWorktree(worktree, prMeta.headRefOid, root)

    reviewRoot = worktree
    head = prMeta.headRefOid
    const mb = git(['merge-base', prMeta.headRefOid, `origin/${prMeta.baseRefName}`], {
      cwd: root,
      allowFail: true,
    })
    if (!mb.ok || !mb.stdout.trim()) {
      removeWorktree(worktree, root)
      fail(`cannot compute merge-base against origin/${prMeta.baseRefName}`)
    }
    base = mb.stdout.trim()
    baseHow = `merge-base ${prMeta.headRefOid.slice(0, 10)} origin/${prMeta.baseRefName}`
  } else {
    // `add -N` so untracked files appear in the diff as additions.
    git(['add', '-N', '.'], { cwd: root, allowFail: true })
    const resolved = resolveLocalBase(root, flags.base)
    base = resolved.base
    baseHow = resolved.how
  }

  const manifest = buildManifest({
    cwd: reviewRoot,
    base,
    head,
    exclude: policy.diffExclude,
    mode,
    reviewRoot,
    prNumber,
  })

  if (!manifest.files.length) {
    if (worktree) removeWorktree(worktree, root)
    return out({
      ok: true,
      empty: true,
      mode,
      base,
      baseHow,
      message: 'no changes to review',
    })
  }

  const runId = mode === 'pr' ? `pr-${prNumber}-${String(head).slice(0, 8)}` : `local-${base.slice(0, 8)}`
  const runDir = join(stateRoot(root), 'runs', runId)

  // The run id is stable for a given base, so a re-run after fixing findings lands in the
  // same directory. Clear the per-pass artifacts: leaving them would make `gk parse` read
  // the previous pass's candidates and verdicts as if they described the current diff.
  // cache/ and dismissals.json live outside the run and are keyed by content, so they
  // correctly survive.
  for (const sub of ['candidates', 'verdicts', 'prompts']) {
    rmSync(join(runDir, sub), { recursive: true, force: true })
    mkdirSync(join(runDir, sub), { recursive: true })
  }
  for (const stale of ['candidates.json', 'reported.json', 'summary.md']) {
    rmSync(join(runDir, stale), { force: true })
  }

  writeFileSync(join(runDir, 'diff.patch'), manifest.patch)
  writeFileSync(join(runDir, 'manifest.md'), renderManifest(manifest))
  const { patch: _patch, ...manifestJson } = manifest
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifestJson, null, 2))

  writeFileSync(join(runDir, 'log.txt'), captureLog({ cwd: reviewRoot, base, head }))

  // applies_to gating: policy is always read from the MAIN repo, never from a PR
  // worktree — review policy belongs to this repo, not to the PR author.
  const checks = loadChecks(root)
  const changed = new Set(manifest.files.map((f) => f.path))
  const selected = []
  const gated = []
  for (const c of checks) {
    if (!c.appliesTo) {
      selected.push(c)
      continue
    }
    const args = ['diff', '--name-only', ...(head ? [base, head] : [base]), '--', ...toPathspec(c.appliesTo)]
    const r = git(args, { cwd: reviewRoot, allowFail: true })
    const matches = r.ok && r.stdout.split('\n').some((p) => p && changed.has(p))
    ;(matches ? selected : gated).push(c)
  }

  const patchTokens = Math.round(manifest.patch.length / 4)
  const groups = groupChecks(selected)

  const meta = {
    runId,
    runDir,
    mode,
    reviewRoot,
    repoRoot: root,
    base,
    baseHow,
    head: head ?? 'working tree',
    prNumber,
    prTitle: prMeta?.title ?? null,
    prUrl: prMeta?.url ?? null,
    prBaseRef: prMeta?.baseRefName ?? null,
    worktree,
    stateDir: stateRoot(root),
    policyPresent: policy.present,
    files: manifest.files.length,
    churn: manifest.churn,
    patchTokens,
    checks: selected.map((c) => ({
      stem: c.stem,
      name: c.name,
      path: c.path,
      description: c.description,
      hints: c.hints,
      group: c.group,
      bytes: c.bytes,
    })),
    gatedOut: gated.map((c) => c.stem),
  }
  writeRunMeta(runDir, meta)

  out({
    ok: true,
    empty: false,
    runDir,
    mode,
    reviewRoot,
    base,
    baseHow,
    head: meta.head,
    prNumber,
    prTitle: prMeta?.title ?? null,
    files: manifest.files.length,
    byClass: countBy(manifest.files, (f) => f.class),
    churn: manifest.churn,
    renames: manifest.renames.length,
    changedDeclarations: manifest.declarations.length,
    patchTokens,
    // A wide diff makes the full check set expensive no matter how it is grouped, and
    // gating cannot help when a sweep touches every path. Ask for a named subset instead.
    wide: patchTokens > WIDE_PATCH_TOKENS,
    checksToRun: selected.map((c) => c.stem),
    agents: groups.length,
    groups: groups.map((g) => ({ id: g.id, checks: g.checks.map((c) => c.stem) })),
    gatedOut: gated.map((c) => c.stem),
    artifacts: {
      manifest: join(runDir, 'manifest.md'),
      diff: join(runDir, 'diff.patch'),
      log: join(runDir, 'log.txt'),
      candidatesDir: join(runDir, 'candidates'),
      verdictsDir: join(runDir, 'verdicts'),
      promptsDir: join(runDir, 'prompts'),
    },
  })
}

function spawnSyncOk(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return !r.error && r.status === 0
}

function countBy(items, fn) {
  const m = {}
  for (const i of items) {
    const k = fn(i)
    m[k] = (m[k] ?? 0) + 1
  }
  return m
}

// Evidence, reference map, and the review prompts in one pass. They always ran back to
// back, neither read the other's output, and splitting them cost the orchestrator an extra
// round trip and an extra JSON result for no decision it could act on in between.
async function cmdContext(flags) {
  const runDir = requireRunDir(flags)
  const meta = runMeta(runDir)
  const policy = await loadPolicy(meta.repoRoot)

  const head = meta.head === 'working tree' ? null : meta.head

  // Selection happens between `prepare` and here, so this is the first point at which the
  // final check set — and therefore the prompt set — is known.
  let selected = meta.checks
  if (flags.checks) {
    const want = String(flags.checks).split(',').map((s) => s.trim()).filter(Boolean)
    const known = new Map(meta.checks.map((c) => [c.stem, c]))
    const missing = want.filter((s) => !known.has(s))
    if (missing.length) {
      fail(`unknown or gated-out check(s): ${missing.join(', ')}`, {
        available: meta.checks.map((c) => c.stem),
      })
    }
    selected = want.map((s) => known.get(s))
  }

  // PR mode reads CI rather than installing. Not cached: a re-run is how a pending job
  // becomes a settled one, and freezing "in progress" would defeat that.
  const ci =
    meta.mode === 'pr'
      ? fetchCiEvidence({
          cwd: meta.repoRoot,
          headSha: head,
          baseRef: meta.prBaseRef,
          defaultBranch: (defaultBranchRef(meta.repoRoot) ?? '').replace(/^origin\//, '') || null,
        })
      : null

  const results = runAnalyzers({
    analyzers: policy.analyzers,
    cwd: meta.reviewRoot,
    base: meta.base,
    head,
    deep: Boolean(flags.deep),
    cacheDir: join(meta.stateDir, 'cache'),
    ciAvailable: Boolean(ci?.available && ci.runs.length),
  })

  const ciSummary = ci
    ? {
        available: ci.available,
        reason: ci.reason || undefined,
        note: ci.note || undefined,
        total: ci.runs.length,
        ...countBy(ci.runs, (r) => r.status),
      }
    : undefined

  writeFileSync(join(runDir, 'evidence.md'), renderEvidence(results, { policyPresent: policy.present, ci }))

  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'))
  const n = buildNeighborhood({ manifest, cwd: meta.reviewRoot })
  writeFileSync(join(runDir, 'neighborhood.md'), renderNeighborhood(n))

  const groups = groupChecks(selected)
  const agents = groups.map((g) => {
    const path = join(runDir, 'prompts', `review-${g.fileId}.txt`)
    writeFileSync(path, renderReviewPrompt({ group: g, runDir, reviewRoot: meta.reviewRoot, base: meta.base }))
    return { id: g.id, checks: g.checks.map((c) => c.stem), prompt: path }
  })

  writeRunMeta(runDir, {
    ...meta,
    selected: selected.map((c) => c.stem),
    groups: groups.map((g) => ({ id: g.id, checks: g.checks.map((c) => c.stem) })),
    evidence: results.map((r) => ({ name: r.name, status: r.status })),
    ci: ciSummary ?? null,
  })

  out({
    ok: true,
    policyPresent: policy.present,
    artifacts: {
      evidence: join(runDir, 'evidence.md'),
      neighborhood: join(runDir, 'neighborhood.md'),
    },
    ci: ciSummary,
    results: results.map((r) => ({
      name: r.name,
      status: r.status,
      reason: r.reason || undefined,
      cached: r.cached || undefined,
      didWork: r.status === 'skipped' ? undefined : r.didWork,
    })),
    neighborhood: {
      available: n.available,
      mapped: n.entries.length,
      orphanSymbols: n.entries.flatMap((e) =>
        Object.entries(e.refs)
          .filter(([, refs]) => refs.length === 0)
          .map(([s]) => `${e.path}:${s}`)
      ),
      filesWithoutTests: n.entries.filter((e) => e.tests.length === 0).map((e) => e.path),
    },
    checks: selected.length,
    agents,
  })
}

function cmdParse(flags) {
  const runDir = requireRunDir(flags)
  const meta = runMeta(runDir)
  const reports = loadCandidates(join(runDir, 'candidates'))

  if (!reports.length) {
    return out({
      ok: true,
      reports: 0,
      findings: [],
      verifyAgents: [],
      message: 'no candidate files found in candidates/',
    })
  }

  const { findings, possibleDuplicates } = dedupe(reports)
  const withIds = assignIds(findings)
  const dismissals = loadDismissals(meta.stateDir)

  writeFileSync(
    join(runDir, 'candidates.json'),
    JSON.stringify(
      {
        reports: reports.map(({ findings: _f, ...r }) => r),
        findings: withIds,
        possibleDuplicates,
      },
      null,
      2
    )
  )

  mkdirSync(join(runDir, 'prompts'), { recursive: true })
  const verifyAgents = batch(withIds).map((group, i) => {
    const path = join(runDir, 'prompts', `verify-${String(i + 1).padStart(2, '0')}.txt`)
    writeFileSync(
      path,
      renderVerifyPrompt({ findings: group, runDir, reviewRoot: meta.reviewRoot, base: meta.base })
    )
    return { prompt: path, ids: group.map((f) => f.id) }
  })

  out({
    ok: true,
    reports: reports.length,
    passed: reports.filter((r) => r.status === 'PASS').map((r) => r.check),
    failed: reports.filter((r) => r.status === 'FAIL').map((r) => r.check),
    findings: withIds.map((f) => ({
      id: f.id,
      title: f.title,
      file: f.file,
      line: f.line,
      severity: f.severity,
      type: f.type,
      checks: f.checks,
      evidenceCount: f.evidence.length,
      alreadyDismissed: Boolean(dismissals[f.fingerprint]),
    })),
    possibleDuplicates,
    verifyAgents,
    artifact: join(runDir, 'candidates.json'),
  })
}

function cmdRank(flags) {
  const runDir = requireRunDir(flags)
  const meta = runMeta(runDir)
  const candidatesPath = join(runDir, 'candidates.json')
  if (!existsSync(candidatesPath)) fail('no candidates.json — run `gk parse` first')

  const { reports, findings, possibleDuplicates } = JSON.parse(readFileSync(candidatesPath, 'utf8'))
  const verdicts = loadVerdicts(join(runDir, 'verdicts'))
  const dismissals = loadDismissals(meta.stateDir)
  const verifySkipped = Boolean(flags['no-verify'])

  const { reported, suppressed } = rank({
    findings,
    verdicts,
    dismissals,
    fresh: Boolean(flags.fresh),
    verifySkipped,
  })

  const summary = renderSummary({
    reports,
    reported,
    suppressed,
    gatedOut: meta.gatedOut.length,
    evidence: meta.evidence,
    churn: meta.churn,
    possibleDuplicates,
    verifySkipped,
  })

  writeFileSync(join(runDir, 'summary.md'), summary)
  writeFileSync(join(runDir, 'reported.json'), JSON.stringify(reported, null, 2))

  out({
    ok: true,
    summary,
    reported: reported.map((f) => ({
      id: f.id,
      fingerprint: f.fingerprint,
      title: f.title,
      file: f.file,
      line: f.line,
      severity: f.severity,
      type: f.type,
      verdict: f.verdict,
      checks: f.checks,
      hasDiff: Boolean(f.diff),
    })),
    suppressed,
    artifacts: {
      summary: join(runDir, 'summary.md'),
      reported: join(runDir, 'reported.json'),
    },
  })
}

function cmdDismiss(flags) {
  const runDir = requireRunDir(flags)
  const meta = runMeta(runDir)
  const ids = String(flags.id ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!ids.length) fail('pass --id F01[,F02]')
  if (!flags.date) fail('pass --date YYYY-MM-DD (the engine has no trusted clock)')

  const reportedPath = join(runDir, 'reported.json')
  if (!existsSync(reportedPath)) fail('no reported.json — run `gk rank` first')
  const reported = JSON.parse(readFileSync(reportedPath, 'utf8'))

  const done = []
  for (const id of ids) {
    const f = reported.find((x) => x.id === id)
    if (!f) continue
    recordDismissal(meta.stateDir, f, String(flags.date))
    done.push({ id, fingerprint: f.fingerprint, title: f.title })
  }
  out({
    ok: true,
    dismissed: done,
    stateFile: join(meta.stateDir, 'dismissals.json'),
  })
}

function cmdCleanup(flags) {
  const root = repoRoot()
  const state = stateRoot(root)
  const results = { worktreesRemoved: [], runsPruned: [], warnings: [] }

  // Remove every gatekeeper worktree, not just this run's. A crashed run leaves one
  // behind, and a leaked worktree keeps a stale checkout on disk and dirties
  // `git worktree list` in the user's repo.
  const wtRoot = join(state, 'worktrees')
  if (existsSync(wtRoot)) {
    for (const name of readdirSync(wtRoot)) {
      const path = join(wtRoot, name)
      if (removeWorktree(path, root)) results.worktreesRemoved.push(path)
      else results.warnings.push(`could not remove worktree: run \`git worktree remove --force ${path}\``)
      if (existsSync(path)) {
        try {
          rmSync(path, { recursive: true, force: true })
        } catch {
          results.warnings.push(`worktree directory still on disk: ${path}`)
        }
      }
    }
  }

  const keepDays = Number(flags['keep-days'] ?? 30)
  const cutoff = flags.now ? Date.parse(flags.now) - keepDays * 86400000 : null
  const runsRoot = join(state, 'runs')
  if (cutoff && existsSync(runsRoot)) {
    for (const name of readdirSync(runsRoot)) {
      const path = join(runsRoot, name)
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true })
        results.runsPruned.push(name)
      }
    }
  }

  if (flags.run) {
    const path = resolve(String(flags.run))
    if (path.startsWith(join(state, 'runs')) && existsSync(path)) {
      rmSync(path, { recursive: true, force: true })
      results.runsPruned.push(path)
    }
  }

  out({
    ok: true,
    ...results,
    note: 'dismissals.json and cache/ are persistent state and were not touched',
  })
}

function requireRunDir(flags) {
  if (!flags.run) fail('pass --run <runDir> (printed by `gk prepare`)')
  const dir = resolve(String(flags.run))
  if (!existsSync(dir)) fail(`run directory does not exist: ${dir}`)
  return dir
}

const COMMANDS = {
  prepare: cmdPrepare,
  context: cmdContext,
  parse: cmdParse,
  rank: cmdRank,
  dismiss: cmdDismiss,
  cleanup: cmdCleanup,
}

const { flags, positional } = parseArgs(process.argv.slice(2))
const command = positional[0]

if (!command || command === 'help' || flags.help) {
  process.stdout.write(
    `gk — Gatekeeper deterministic engine

  gk prepare [--pr <url|number>] [--base <ref>]
      Resolve the review target, capture the diff, build the manifest, gate checks
      by applies_to, and group them into agents. In PR mode this creates a detached
      worktree. Reports \`wide: true\` when the patch is too large for the full set.

  gk context --run <dir> [--checks a,b] [--deep]
      Run .gatekeeper/analyzers.mjs (cached per analyzer input hash), map who
      references the changed code, and write one ready-to-use review prompt per
      agent into prompts/. In PR mode also reads the check runs attached to the
      reviewed commit. Pass --checks to narrow the set the prompts cover.

  gk parse --run <dir>
      Aggregate agent-written candidates/*.md into findings with stable ids, and
      write batched verification prompts into prompts/.

  gk rank --run <dir> [--no-verify] [--fresh]
      Apply verdicts from verdicts/, drop dismissed findings, rank, emit summary.

  gk dismiss --run <dir> --id F01[,F02] --date YYYY-MM-DD
      Remember a Skip so it is never asked again.

  gk cleanup [--run <dir>] [--now <ISO>] [--keep-days 30]
      Remove worktrees and prune old runs. Never touches dismissals or cache.
`
  )
  process.exit(0)
}

if (!COMMANDS[command]) fail(`unknown command: ${command}`)

try {
  await COMMANDS[command](flags)
} catch (err) {
  fail(err.message, { stack: process.env.GK_DEBUG ? err.stack : undefined })
}
