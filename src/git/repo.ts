/**
 * Repositories, branches, worktrees and remotes — the things the toolbar's
 * four dropdowns select between.
 */
import { git, gitText, splitNul } from './exec'

export interface Branch {
  name: string
  /** `origin/main`, when the branch tracks something. */
  upstream?: string
  ahead: number
  behind: number
  current: boolean
  /** ISO 8601 date of the tip commit, for sorting by recency. */
  updated: string
  subject: string
}

export interface Worktree {
  path: string
  branch?: string
  head: string
  /** The worktree the repository was opened from. */
  main: boolean
  /** A worktree whose directory is gone but whose registration remains. */
  prunable: boolean
  locked: boolean
}

export interface Remote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export interface RepoInfo {
  /** Absolute path to the worktree root. */
  root: string
  /** Directory name, used as the display name. */
  name: string
  /** True when the repo has no commits yet. */
  empty: boolean
}

/** Resolve a path to its repository root, or null when it is not in one. */
export async function open(path: string): Promise<RepoInfo | null> {
  const { stdout, exitCode } = await git(path, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  if (exitCode !== 0)
    return null

  const root = stdout.trim()
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })

  return {
    root,
    name: root.split('/').filter(Boolean).pop() ?? root,
    empty: head.exitCode !== 0,
  }
}

export async function branches(repo: string): Promise<Branch[]> {
  // for-each-ref rather than `branch -vv`: the latter's output is a display
  // format that has changed shape between git versions, and its upstream
  // column is wrapped in brackets mixed into the subject.
  const format = ['%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)', '%(committerdate:iso-strict)', '%(contents:subject)'].join('\x1F')
  const { stdout } = await git(repo, ['for-each-ref', `--format=${format}`, '--sort=-committerdate', 'refs/heads'])

  return stdout.split('\n').filter(Boolean).map((line) => {
    const [name, upstream, track, head, updated, subject] = line.split('\x1F')
    // `[ahead 2, behind 1]`, `[ahead 3]`, `[gone]`, or empty.
    const ahead = Number.parseInt(track?.match(/ahead (\d+)/)?.[1] ?? '0', 10)
    const behind = Number.parseInt(track?.match(/behind (\d+)/)?.[1] ?? '0', 10)
    return {
      name,
      upstream: upstream || undefined,
      ahead,
      behind,
      current: head === '*',
      updated,
      subject,
    }
  })
}

export async function worktrees(repo: string): Promise<Worktree[]> {
  const { stdout } = await git(repo, ['worktree', 'list', '--porcelain', '-z'])

  // The porcelain form is attribute-per-line, with a blank line between
  // entries. Under `-z` the separator is a NUL and entries are separated by
  // an empty field.
  const trees: Worktree[] = []
  let current: Partial<Worktree> | null = null

  const flush = () => {
    if (current?.path)
      trees.push({ main: trees.length === 0, prunable: false, locked: false, head: '', ...current } as Worktree)
    current = null
  }

  for (const field of splitNul(stdout)) {
    if (field === '') {
      flush()
      continue
    }
    const spaceAt = field.indexOf(' ')
    const key = spaceAt === -1 ? field : field.slice(0, spaceAt)
    const value = spaceAt === -1 ? '' : field.slice(spaceAt + 1)

    current ??= {}
    switch (key) {
      case 'worktree': current.path = value; break
      case 'HEAD': current.head = value; break
      // Given as a full ref (`refs/heads/main`); the UI wants the short name.
      case 'branch': current.branch = value.replace(/^refs\/heads\//, ''); break
      case 'locked': current.locked = true; break
      case 'prunable': current.prunable = true; break
      case 'detached': current.branch = undefined; break
    }
  }
  flush()

  return trees
}

export async function remotes(repo: string): Promise<Remote[]> {
  const output = await gitText(repo, ['remote', '-v'])
  const byName = new Map<string, Remote>()

  for (const line of output.split('\n').filter(Boolean)) {
    // `origin\tgit@github.com:o/r.git (fetch)`
    const [name, rest] = line.split('\t')
    if (!rest)
      continue
    const url = rest.slice(0, rest.lastIndexOf(' '))
    const kind = rest.slice(rest.lastIndexOf(' ') + 2, -1)

    const entry = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch')
      entry.fetchUrl = url
    else
      entry.pushUrl = url
    byName.set(name, entry)
  }

  return [...byName.values()]
}

/** When the last fetch happened, from the remote's FETCH_HEAD mtime. */
export async function lastFetch(repo: string): Promise<Date | null> {
  const gitDir = await gitText(repo, ['rev-parse', '--git-dir'])
  // A relative git-dir is relative to the worktree root, not to the process.
  const path = gitDir.startsWith('/') ? gitDir : `${repo}/${gitDir}`
  const file = Bun.file(`${path}/FETCH_HEAD`)
  if (!(await file.exists()))
    return null
  return new Date(file.lastModified)
}
