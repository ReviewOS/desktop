/**
 * Commit history.
 *
 * `--pretty=format:` with a field separator no commit message can contain, so
 * a subject with a newline, a tab or a pipe in it still parses. git offers
 * `%x1f`/`%x1e` (ASCII unit/record separators) precisely for this.
 */
import { git } from './exec'

const UNIT = '\x1F'
const RECORD = '\x1E'

const FORMAT = [
  '%H', // full hash
  '%h', // abbreviated
  '%an', // author name
  '%ae', // author email
  '%aI', // author date, strict ISO 8601
  '%s', // subject
  '%b', // body
  '%P', // parent hashes, space separated
  '%D', // ref names ("HEAD -> main, tag: v1.0, origin/main")
].join(UNIT) + RECORD

export interface Commit {
  hash: string
  short: string
  authorName: string
  authorEmail: string
  /** Strict ISO 8601, with the author's own offset preserved. */
  date: string
  subject: string
  body: string
  parents: string[]
  /** Branch and tag names pointing at this commit. */
  refs: string[]
  /** True when the commit has more than one parent. */
  merge: boolean
}

export interface LogOptions {
  limit?: number
  /** Start from this ref instead of HEAD. */
  ref?: string
  /** Restrict history to commits touching this path. */
  path?: string
  /** Skip this many commits — the paging cursor. */
  skip?: number
}

export async function log(repo: string, options: LogOptions = {}): Promise<Commit[]> {
  const args = [
    'log',
    `--pretty=format:${FORMAT}`,
    `--max-count=${options.limit ?? 100}`,
  ]
  if (options.skip)
    args.push(`--skip=${options.skip}`)
  args.push(options.ref ?? 'HEAD')
  // `--` terminates revisions, so a path that happens to look like a ref
  // (a directory called `main`, say) is read as a path.
  if (options.path)
    args.push('--', options.path)

  // An empty repository has no HEAD to log. That is a normal state for a
  // freshly-initialized repo, not a failure, so it reports as no commits.
  const { stdout, exitCode } = await git(repo, args, { allowFailure: true })
  if (exitCode !== 0)
    return []

  return stdout
    .split(RECORD)
    .map(record => record.replace(/^\n/, ''))
    .filter(record => record.length > 0)
    .map(parseCommit)
}

function parseCommit(record: string): Commit {
  const [hash, short, authorName, authorEmail, date, subject, body, parents, refs] = record.split(UNIT)
  const parentList = parents ? parents.split(' ').filter(Boolean) : []

  return {
    hash,
    short,
    authorName,
    authorEmail,
    date,
    subject,
    body: (body ?? '').trim(),
    parents: parentList,
    refs: refs ? refs.split(', ').filter(Boolean) : [],
    merge: parentList.length > 1,
  }
}

/** The files a single commit touched, for the history pane's file list. */
export interface CommitFile {
  path: string
  oldPath?: string
  status: string
  additions: number
  deletions: number
}

export async function commitFiles(repo: string, hash: string): Promise<CommitFile[]> {
  // `--numstat` and `--name-status` each carry half the answer, and asking for
  // both in one `git show` interleaves them in a format that is worse to parse
  // than two calls. numstat already carries the paths, so it alone is enough;
  // the status letter comes from a second, cheap name-status pass.
  const [numstat, nameStatus] = await Promise.all([
    git(repo, ['show', '--numstat', '--format=', '--find-renames', '-z', hash]),
    git(repo, ['show', '--name-status', '--format=', '--find-renames', '-z', hash]),
  ])

  const statuses = new Map<string, string>()
  const statusFields = nameStatus.stdout.split('\0').filter(Boolean)
  for (let i = 0; i < statusFields.length;) {
    const letter = statusFields[i++]
    // R and C are followed by TWO paths (source, destination); everything else
    // by one. Keyed on the destination, which is what numstat reports.
    if (letter.startsWith('R') || letter.startsWith('C')) {
      i++ // source
      statuses.set(statusFields[i++], letter)
    }
    else {
      statuses.set(statusFields[i++], letter)
    }
  }

  const files: CommitFile[] = []
  const numFields = numstat.stdout.split('\0').filter(Boolean)
  for (let i = 0; i < numFields.length;) {
    const line = numFields[i++]
    const [added, deleted, inlinePath] = line.split('\t')

    // For a rename, numstat writes an empty path in the line and follows it
    // with the source and destination as two separate NUL-terminated fields.
    let path = inlinePath
    let oldPath: string | undefined
    if (!path) {
      oldPath = numFields[i++]
      path = numFields[i++]
    }

    files.push({
      path,
      oldPath,
      status: statuses.get(path) ?? 'M',
      // A binary file's counts are `-`, which is not zero — it is "unknown".
      additions: added === '-' ? 0 : Number.parseInt(added, 10),
      deletions: deleted === '-' ? 0 : Number.parseInt(deleted, 10),
    })
  }

  return files
}
