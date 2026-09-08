import { spawnSync } from 'node:child_process'
import { basename, extname } from 'node:path'
import { git } from './git.mjs'

const MAX_FILES = 12
const MAX_SYMBOLS_PER_FILE = 6
const MAX_REFS_PER_SYMBOL = 8
const MAX_TESTS_PER_SYMBOL = 3

function rg(args, cwd) {
  const res = spawnSync('rg', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 20000 })
  if (res.error || res.status > 1) return null // status 1 just means "no matches"
  return (res.stdout ?? '').split('\n').filter((l) => l !== '')
}

function rgAvailable() {
  const res = spawnSync('rg', ['--version'], { encoding: 'utf8' })
  return !res.error && res.status === 0
}

function referencesTo(symbol, cwd, selfPath) {
  const hits = rg(['-l', '--word-regexp', '--glob', '!**/_generated/**', '--', symbol, '.'], cwd)
  if (!hits) return []
  return hits
    .map((p) => p.replace(/^\.\//, ''))
    .filter((p) => p !== selfPath)
    .slice(0, MAX_REFS_PER_SYMBOL)
}

function testsFor(symbol, cwd) {
  const hits = rg(
    ['-l', '--word-regexp', '--glob', '**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts}', '--', symbol, '.'],
    cwd
  )
  if (!hits) return []
  return hits.map((p) => p.replace(/^\.\//, '')).slice(0, MAX_TESTS_PER_SYMBOL)
}

function importersOf(path, cwd) {
  const stem = basename(path, extname(path))
  if (!stem || stem.length < 3) return []
  const hits = rg(['-l', '--glob', '!**/_generated/**', '--', `from ['"].*${stem}['"]`, '.'], cwd)
  if (!hits) return []
  return hits
    .map((p) => p.replace(/^\.\//, ''))
    .filter((p) => p !== path)
    .slice(0, MAX_REFS_PER_SYMBOL)
}

function historyFor(path, cwd) {
  const r = git(['log', '-n', '3', '--format=%h %s', '--', path], { cwd, allowFail: true })
  return r.ok ? r.stdout.split('\n').filter(Boolean) : []
}

// The file list comes from the manifest, which is already filtered by diff_exclude.
// Re-deriving it from git here would silently reintroduce generated files, and mapping
// the reference graph of a generated API surface wastes the entire stage.
export function buildNeighborhood({ manifest, cwd }) {
  if (!rgAvailable()) return { available: false, entries: [] }

  const targets = manifest.files
    .filter((f) => f.class === 'source' || f.class === 'schema')
    .filter((f) => f.status !== 'D')
    .slice(0, MAX_FILES)

  const entries = []
  for (const file of targets) {
    // Exported declarations only. A local `const` inside a Vue <script setup> block has
    // no cross-file reference graph by definition, so mapping it produces a guaranteed
    // "no references anywhere" that reads as a real signal and is not one.
    const symbols = [
      ...new Set(
        manifest.declarations
          .filter((d) => d.file === file.path && d.sign === '+' && d.exported)
          .map((d) => d.name)
      ),
    ].slice(0, MAX_SYMBOLS_PER_FILE)

    const refs = new Map()
    const tests = new Set()
    for (const s of symbols) {
      refs.set(s, referencesTo(s, cwd, file.path))
      for (const t of testsFor(s, cwd)) tests.add(t)
    }

    entries.push({
      path: file.path,
      status: file.status,
      added: file.added,
      removed: file.removed,
      symbols,
      refs: Object.fromEntries(refs),
      importers: importersOf(file.path, cwd),
      tests: [...tests],
      history: historyFor(file.path, cwd),
    })
  }

  return { available: true, entries, truncated: manifest.files.filter((f) => f.class === 'source').length > MAX_FILES }
}

export function renderNeighborhood(n) {
  const L = ['# Neighborhood', '']
  if (!n.available) {
    L.push('ripgrep is unavailable, so no reference mapping was built.', '')
    return L.join('\n')
  }
  if (!n.entries.length) {
    L.push('No source files in this change set to map.', '')
    return L.join('\n')
  }
  L.push(
    'Ranked by churn. This is your starting point for lookups — prefer it to searching the',
    'repository yourself.',
    ''
  )

  for (const e of n.entries) {
    L.push(`## ${e.path}  [${e.status} +${e.added}/-${e.removed}]`, '')
    if (e.symbols.length) L.push(`changed symbols: ${e.symbols.join(', ')}`)

    const allRefs = new Set()
    for (const [sym, files] of Object.entries(e.refs)) {
      if (!files.length) {
        L.push(`  ${sym}: NO references anywhere in the repo`)
      } else {
        for (const f of files) allRefs.add(f)
        L.push(`  ${sym}: ${files.length} referencing file(s)`)
      }
    }
    if (allRefs.size) {
      L.push('referenced by:')
      for (const f of allRefs) L.push(`  ${f}`)
    }
    if (e.importers.length) {
      L.push('imports this module:')
      for (const f of e.importers) L.push(`  ${f}`)
    }
    L.push(e.tests.length ? 'tests:' : 'tests: NONE found for the changed symbols')
    for (const t of e.tests) L.push(`  ${t}`)
    if (e.history.length) {
      L.push('recent history:')
      for (const h of e.history) L.push(`  ${h}`)
    }
    L.push('')
  }

  if (n.truncated) L.push(`Note: only the ${MAX_FILES} highest-churn source files were mapped.`, '')
  return L.join('\n')
}
