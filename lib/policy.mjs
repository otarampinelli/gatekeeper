import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// No YAML. Check frontmatter uses five keys, every one a scalar or a list of scalars, and
// the analyzer policy is a plain ES module — so neither needs a parser. The engine stays
// dependency-free because copying `.gatekeeper/` into another repo has to bring a working
// reviewer with it, not a package.json edit.

function unquote(value) {
  const s = value.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

// `key: scalar` sets a value; a bare `key:` opens a list that the following `  - item`
// lines fill. Anything else in the block is ignored rather than throwing: a check with
// odd frontmatter should degrade to its defaults, never break the run that reads it.
export function parseFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return {}
  const end = lines.indexOf('---', 1)
  if (end < 0) return {}

  const out = {}
  let listKey = null
  for (const raw of lines.slice(1, end)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue

    const item = /^\s+-\s+(.*)$/.exec(raw)
    if (item && listKey) {
      out[listKey].push(unquote(item[1]))
      continue
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(raw)
    if (!kv) continue
    const [, key, rest] = kv
    if (rest.trim()) {
      out[key] = unquote(rest)
      listKey = null
    } else {
      out[key] = []
      listKey = key
    }
  }
  return out
}

const DEFAULT_EXCLUDE = ['**/_generated/**', '**/*.snap']

export async function loadPolicy(repoRoot) {
  const path = join(repoRoot, '.gatekeeper', 'analyzers.mjs')
  if (!existsSync(path)) {
    return { present: false, diffExclude: DEFAULT_EXCLUDE, analyzers: [] }
  }
  try {
    const mod = await import(pathToFileURL(path).href)
    const doc = mod.default ?? mod
    return {
      present: true,
      diffExclude: Array.isArray(doc.diffExclude) ? doc.diffExclude : DEFAULT_EXCLUDE,
      analyzers: Array.isArray(doc.analyzers) ? doc.analyzers : [],
    }
  } catch (err) {
    // A malformed policy file must degrade the review, never abort it.
    return { present: false, error: String(err.message), diffExclude: DEFAULT_EXCLUDE, analyzers: [] }
  }
}

export function loadChecks(repoRoot, checksDir = '.gatekeeper/checks') {
  const root = join(repoRoot, checksDir)
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSorted(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md')) {
        const text = readFileSync(full, 'utf8')
        const fm = parseFrontmatter(text)
        const rel = full.slice(root.length + 1)
        const stem = rel.replace(/\.md$/, '')
        out.push({
          path: full,
          rel,
          stem,
          name: fm.name || titleize(rel),
          description: fm.description || '',
          appliesTo: Array.isArray(fm.applies_to) && fm.applies_to.length ? fm.applies_to : null,
          hints: Array.isArray(fm.hints) ? fm.hints : [],
          // An ungrouped check is its own group, so it still gets exactly one agent.
          group: typeof fm.group === 'string' && fm.group ? fm.group : stem,
          bytes: text.length,
        })
      }
    }
  }
  walk(root)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function readdirSorted(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
}

function titleize(rel) {
  return rel
    .replace(/\.md$/, '')
    .split('/')
    .map((seg) => seg.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))
    .join(' / ')
}

// One group is one agent. This is the engine's largest cost lever: the checks with no
// `applies_to` survive gating on every review and each read the whole patch, so eleven of
// them meant paying eleven times for the same bytes.
//
// The cap is on combined instruction bytes, not member count — four short checks share an
// agent cheaply, two long ones would crowd the diff out of the same context. It exists to
// catch a group that grows over time, so under normal policy it never fires.
const GROUP_BYTE_CAP = 24000

export function groupChecks(checks, cap = GROUP_BYTE_CAP) {
  const order = []
  const byGroup = new Map()
  for (const c of checks) {
    if (!byGroup.has(c.group)) {
      byGroup.set(c.group, [])
      order.push(c.group)
    }
    byGroup.get(c.group).push(c)
  }

  const buckets = []
  for (const name of order) {
    let bucket = []
    let bytes = 0
    for (const c of byGroup.get(name)) {
      if (bucket.length && bytes + c.bytes > cap) {
        buckets.push(bucket)
        bucket = []
        bytes = 0
      }
      bucket.push(c)
      bytes += c.bytes
    }
    if (bucket.length) buckets.push(bucket)
  }

  const seen = new Map()
  return buckets.map((members) => {
    const base = members[0].group
    const total = buckets.filter((b) => b[0].group === base).length
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    const id = total > 1 ? `${base}-${n}` : base
    return {
      id,
      // Group ids reach the filesystem as prompt filenames, and a default group id is a
      // check stem, which can contain a directory separator.
      fileId: id.replaceAll('/', '__'),
      checks: members,
      bytes: members.reduce((a, c) => a + c.bytes, 0),
    }
  })
}

export function toPathspec(globs) {
  return globs.map((g) => `:(glob)${g}`)
}

export function toExcludePathspec(globs) {
  return globs.map((g) => `:(exclude,glob)${g}`)
}
