import { git, gitLines } from './git.mjs'
import { toExcludePathspec } from './policy.mjs'

const DECL = /^([+-])[ \t]*(export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(function|class|interface|type|enum|namespace|const|let|var)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/

function classify(path) {
  if (/(^|\/)_generated\//.test(path) || /\.gen\.[jt]s$/.test(path)) return 'generated'
  if (/\.(test|spec)\.[jt]sx?$/.test(path) || /(^|\/)__tests__\//.test(path)) return 'test'
  if (/(^|\/)schema\.ts$/.test(path) || /(^|\/)migrations\//.test(path)) return 'schema'
  if (/\.(md|mdx)$/.test(path) || /(^|\/)docs?\//.test(path)) return 'docs'
  if (/\.(json|ya?ml|toml|ini)$/.test(path) || /\.config\.[jt]s$/.test(path) || /(^|\/)\.[a-z]/.test(path)) return 'config'
  return 'source'
}

function diffArgs(base, head, exclude) {
  const range = head ? [base, head] : [base]
  return [...range, '--', '.', ...toExcludePathspec(exclude)]
}

function captureDiff({ cwd, base, head, exclude }) {
  const { stdout } = git(['diff', '--find-renames', '--find-copies', ...diffArgs(base, head, exclude)], { cwd })
  return stdout
}

export function captureLog({ cwd, base, head }) {
  const spec = head ? `${base}..${head}` : `${base}..HEAD`
  const r = git(['log', spec, '--oneline'], { cwd, allowFail: true })
  return r.ok ? r.stdout : ''
}

// Share of the diff that's content on both sides: moves/reindents, not new behavior.
// Strips ' \t' per line, not \s, since stripping all whitespace would eat the newlines too.
export function churn(patch) {
  const norm = (sign, skip) =>
    patch
      .split('\n')
      .filter((l) => l.startsWith(sign) && !l.startsWith(skip))
      .map((l) => l.slice(1).replace(/[ \t]/g, ''))
      .filter((l) => l !== '')

  const added = norm('+', '+++')
  const removed = norm('-', '---')
  const pool = new Map()
  for (const l of removed) pool.set(l, (pool.get(l) ?? 0) + 1)
  let identical = 0
  for (const l of added) {
    const n = pool.get(l)
    if (n) {
      identical++
      pool.set(l, n - 1)
    }
  }
  return { added: added.length, removed: removed.length, identical }
}

export function declarations(patch) {
  const out = []
  let file = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length)
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue
    const m = DECL.exec(line)
    if (m && file) out.push({ sign: m[1], exported: Boolean(m[2]), kind: m[3], name: m[4], file })
  }
  return out
}

export function buildManifest({ cwd, base, head, exclude, mode, reviewRoot, prNumber }) {
  const patch = captureDiff({ cwd, base, head, exclude })

  const nameStatus = gitLines(
    ['diff', '--find-renames', '--find-copies', '--name-status', ...diffArgs(base, head, exclude)],
    { cwd }
  )
  const numstat = gitLines(
    ['diff', '--find-renames', '--find-copies', '--numstat', ...diffArgs(base, head, exclude)],
    { cwd }
  )

  const stats = new Map()
  for (const line of numstat) {
    const [add, del, ...rest] = line.split('\t')
    const path = rest[rest.length - 1]
    stats.set(path, { added: add === '-' ? 0 : Number(add), removed: del === '-' ? 0 : Number(del), binary: add === '-' })
  }

  const files = []
  const renames = []
  for (const line of nameStatus) {
    const parts = line.split('\t')
    const status = parts[0]
    if (status.startsWith('R') || status.startsWith('C')) {
      const [, from, to] = parts
      renames.push({ from, to, similarity: status.slice(1), kind: status[0] === 'R' ? 'rename' : 'copy' })
      files.push({ path: to, status: status[0], from, ...(stats.get(to) ?? { added: 0, removed: 0 }), class: classify(to) })
    } else {
      const path = parts[1]
      files.push({ path, status, ...(stats.get(path) ?? { added: 0, removed: 0 }), class: classify(path) })
    }
  }

  files.sort((a, b) => b.added + b.removed - (a.added + a.removed))

  return {
    mode,
    reviewRoot,
    prNumber: prNumber ?? null,
    base,
    head: head ?? 'working tree',
    files,
    renames,
    churn: churn(patch),
    declarations: declarations(patch),
    patch,
  }
}

export function renderManifest(m) {
  const L = []
  L.push('# Change Manifest', '')
  L.push(`base: ${m.base}`)
  L.push(`head: ${m.head}`)
  L.push(`mode: ${m.mode}${m.prNumber ? ` (PR #${m.prNumber})` : ''}`)
  L.push(`review root: ${m.reviewRoot}`, '')

  L.push(`## Files (${m.files.length})`, '')
  L.push('| file | status | +/- | class |', '|---|---|---|---|')
  for (const f of m.files) {
    L.push(`| ${f.path} | ${f.status} | +${f.added}/-${f.removed} | ${f.class} |`)
  }
  L.push('')

  if (m.renames.length) {
    L.push('## Renames and copies', '')
    for (const r of m.renames) L.push(`${r.from} -> ${r.to} (${r.kind} ${r.similarity}%)`)
    L.push('')
  }

  const { added, removed, identical } = m.churn
  L.push('## Churn shape', '')
  L.push(`added ${added}, removed ${removed}, identical content on both sides ${identical}`)
  if (identical > 0) {
    const pct = Math.round((identical / Math.max(added + removed, 1)) * 100)
    L.push('')
    L.push(
      `Roughly ${identical} of ${added + removed} changed lines (${pct}%) are moves or reindents, ` +
        'not new behavior. Do not review those as if they were new.'
    )
  }
  L.push('')

  if (m.declarations.length) {
    L.push('## Changed declarations', '')
    for (const d of m.declarations.slice(0, 60)) {
      L.push(`${d.sign} ${d.exported ? 'export ' : ''}${d.kind} ${d.name}   ${d.file}`)
    }
    if (m.declarations.length > 60) L.push(`... and ${m.declarations.length - 60} more`)
    L.push('')
  }

  return L.join('\n')
}
