import { spawnSync } from 'node:child_process'

// Every git call goes through here with an explicit argv array — never a shell string.
// A rev:path argument built by string interpolation into a shell is how `$BASE:apps/x.ts`
// gets eaten by zsh's `:a` modifier; argv arrays make that class of bug impossible.
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

// --git-common-dir, not --git-dir: a worktree's own git dir is under
// .git/worktrees/<name>, so state written there would be stranded from the main repo.
// --path-format=absolute because the bare flag returns a relative `.git` from the repo
// root but an absolute path from inside a worktree.
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
