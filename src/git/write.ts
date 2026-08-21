/**
 * The operations that change something.
 *
 * Kept apart from the readers so it is obvious at a glance which module can
 * mutate a repository — and so the server can hold the write endpoints to a
 * stricter standard than the read ones.
 */
import { git } from './exec'

/**
 * Stage exactly these paths, unstage everything else.
 *
 * GitHub Desktop's checkbox model is "the index should match the checked set",
 * not "add what I clicked". Expressing it that way makes the operation
 * idempotent: committing twice with the same selection cannot drift, and a
 * file unchecked between renders gets unstaged rather than silently committed.
 */
export async function setStagedPaths(repo: string, paths: string[]): Promise<void> {
  // Reset the index to HEAD first so previously-staged-but-now-unchecked files
  // drop out. `--` guards against a path that looks like a revision.
  await git(repo, ['reset', '--quiet', 'HEAD', '--'], { allowFailure: true })

  if (paths.length === 0)
    return

  // `--pathspec-from-file` with NUL separators, because a path list on the
  // command line runs into ARG_MAX on a large change set, and a path
  // containing a newline would corrupt a newline-separated file.
  await git(repo, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    stdin: `${paths.join('\0')}\0`,
  })
}

export interface CommitOptions {
  summary: string
  description?: string
  /** Amend the previous commit instead of creating one. */
  amend?: boolean
  /** Extra trailers, e.g. `Co-authored-by`. */
  trailers?: string[]
}

export interface CommitResult {
  hash: string
  summary: string
}

export async function commit(repo: string, options: CommitOptions): Promise<CommitResult> {
  const summary = options.summary.trim()
  if (!summary)
    throw new Error('A commit needs a summary.')

  const message = options.description?.trim()
    ? `${summary}\n\n${options.description.trim()}\n`
    : `${summary}\n`

  const args = ['commit', '--file=-', '--cleanup=strip']
  if (options.amend)
    args.push('--amend')
  for (const trailer of options.trailers ?? [])
    args.push('--trailer', trailer)

  // The message goes in on stdin rather than `-m`, so a message containing
  // anything at all — quotes, backticks, a leading dash — is just bytes.
  await git(repo, args, { stdin: message })

  const { stdout } = await git(repo, ['rev-parse', 'HEAD'])
  return { hash: stdout.trim(), summary }
}

/** Throw away a file's uncommitted changes. Deletes it if it was untracked. */
export async function discard(repo: string, path: string): Promise<void> {
  const tracked = await git(repo, ['ls-files', '--error-unmatch', '--', path], { allowFailure: true })

  if (tracked.exitCode === 0) {
    await git(repo, ['checkout', 'HEAD', '--', path])
    return
  }

  // Untracked: `git clean` rather than an unlink, so the ignore rules and the
  // directory case are git's problem and not a reimplementation of them.
  await git(repo, ['clean', '--force', '-d', '--', path])
}

export interface FetchResult {
  /** What git printed to stderr — its progress output — for the UI to show. */
  output: string
}

export async function fetch(repo: string, remote = 'origin'): Promise<FetchResult> {
  // `--prune` so branches deleted upstream stop appearing in the picker.
  // Failure is returned rather than thrown: being offline is an ordinary
  // condition for a desktop app, not an exception.
  const { stderr, exitCode } = await git(repo, ['fetch', '--prune', remote], { allowFailure: true })
  if (exitCode !== 0)
    throw new Error(stderr.trim() || `Could not fetch from ${remote}.`)
  return { output: stderr.trim() }
}

export async function checkout(repo: string, branch: string): Promise<void> {
  await git(repo, ['checkout', branch])
}
