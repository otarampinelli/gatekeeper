import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// A failed `gh` call is data every caller already handles (not installed, not authed, PR
// not found), never exceptional, so unlike `git()` this never throws.
export async function gh(args, { cwd = process.cwd(), timeout = 60_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 })
    return { ok: true, stdout, stderr }
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message), code: err.code ?? -1 }
  }
}

// Every git call goes through here with an explicit argv array, never a shell string:
// interpolating "$BASE:apps/x.ts" into a shell gets eaten by zsh's `:a` modifier.
export function git(args, { cwd = process.cwd(), allowFail = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer })
  if (res.error) {
    if (allowFail) return { ok: false, stdout: '', stderr: String(res.error.message), code: -1 }
    throw new Error(`git ${args.join(' ')}: ${res.error.message}`)
  }
  const out = { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status }
  if (!out.ok && !allowFail) {
    throw new Error(`git ${args.join(' ')} exited ${res.status}: ${out.stderr.trim()}`)
  }
  return out
}

export function gitLines(args, opts) {
  const { stdout } = git(args, opts)
  return stdout.split('\n').filter((l) => l !== '')
}

function revParse(ref, cwd) {
  const r = git(['rev-parse', ref], { cwd, allowFail: true })
  return r.ok ? r.stdout.trim() : null
}

export function repoRoot(cwd = process.cwd()) {
  return git(['rev-parse', '--show-toplevel'], { cwd }).stdout.trim()
}

// --git-common-dir, not --git-dir: a worktree's own git dir is under .git/worktrees/<name>,
// which would strand state written there. --path-format=absolute avoids a relative `.git`.
export function commonGitDir(cwd = process.cwd()) {
  return git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }).stdout.trim()
}

export function defaultBranchRef(cwd) {
  for (const ref of ['origin/master', 'origin/main', 'master', 'main']) {
    if (revParse(ref, cwd)) return ref
  }
  return null
}

// Pin to the merge-base, never the branch tip: the default branch moves, and a review
// measured against a moving target reports other people's commits as the user's.
export function resolveLocalBase(cwd, explicit) {
  if (explicit) {
    const sha = revParse(explicit, cwd)
    if (!sha) throw new Error(`cannot resolve base ref: ${explicit}`)
    return { base: sha, how: `explicit ${explicit}` }
  }
  const branch = defaultBranchRef(cwd)
  if (branch) {
    const mb = git(['merge-base', branch, 'HEAD'], { cwd, allowFail: true })
    if (mb.ok && mb.stdout.trim()) return { base: mb.stdout.trim(), how: `merge-base ${branch} HEAD` }
  }
  const head = revParse('HEAD', cwd)
  if (head) return { base: head, how: 'HEAD (no default branch found)' }
  throw new Error('cannot resolve a base revision')
}

export function blobHash(path, cwd) {
  const r = git(['hash-object', '--', path], { cwd, allowFail: true })
  return r.ok ? r.stdout.trim() : 'deleted'
}

export function addWorktree(path, commitish, cwd) {
  git(['worktree', 'add', '-q', '--detach', path, commitish], { cwd })
}

export function removeWorktree(path, cwd) {
  const r = git(['worktree', 'remove', '--force', path], { cwd, allowFail: true })
  git(['worktree', 'prune'], { cwd, allowFail: true })
  return r.ok
}
