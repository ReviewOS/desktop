/**
 * The working tree, as `git status --porcelain=v2` describes it.
 *
 * v2 rather than v1 because v1 gives two status letters and a path and nothing
 * else — no similarity score for a rename, no way to tell a submodule from a
 * directory, and a rename's two paths separated by ` -> ` inside a field that
 * can itself contain arrows. v2 is a fixed-field, NUL-terminated format with
 * all of that spelled out, and it costs nothing extra to ask for.
 */
import { git, splitNul } from './exec'

/** What happened to a file, normalized away from git's single letters. */
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'typechange'

export interface ChangedFile {
  /** Repo-relative path. For a rename, the destination. */
  path: string
  /** Where a rename or copy came from. */
  oldPath?: string
  /** The index-vs-HEAD change, if the file has staged content. */
  staged?: ChangeKind
  /** The worktree-vs-index change, if the file has unstaged content. */
  unstaged?: ChangeKind
  /** Rename/copy similarity, 0-100. */
  similarity?: number
  /** Submodule, symlink and regular files render differently. */
  submodule: boolean
}

export interface RepoStatus {
  branch: string
  /** Upstream ref, e.g. `origin/main`. Absent when the branch has no upstream. */
  upstream?: string
  ahead: number
  behind: number
  /** True on a detached HEAD, where `branch` holds the abbreviated commit. */
  detached: boolean
  files: ChangedFile[]
}

/**
 * git's XY status letters.
 *
 * `T` (typechange) is included because it is easy to forget and produces a
 * genuinely different diff — a file becoming a symlink is neither a plain
 * modification nor a delete-plus-add.
 */
function kindOf(letter: string): ChangeKind | undefined {
  switch (letter) {
    case 'A': return 'added'
    case 'M': return 'modified'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'typechange'
    default: return undefined
  }
}

export async function status(repo: string): Promise<RepoStatus> {
  const { stdout } = await git(repo, [
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=all',
    // Rename detection is off by default in porcelain output. Without it a
    // moved file shows up as an unrelated delete plus an unrelated add, which
    // is exactly the thing a review tool must not do.
    '--find-renames',
    '-z',
  ])

  const result: RepoStatus = { branch: '', ahead: 0, behind: 0, detached: false, files: [] }

  // A `2` (rename/copy) record's origin path is a *separate* NUL-terminated
  // field following the record, so the reader is an index loop rather than a
  // for-of — it has to be able to consume the next field mid-record.
  const records = splitNul(stdout)
  for (let i = 0; i < records.length; i++) {
    const record = records[i]

    if (record.startsWith('# ')) {
      readHeader(record, result)
      continue
    }

    if (record.startsWith('? ')) {
      result.files.push({ path: record.slice(2), unstaged: 'untracked', submodule: false })
      continue
    }

    if (record.startsWith('u ')) {
      // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — the path is
      // field 10, and it is the only field that can contain spaces, so the
      // rest is rejoined rather than taken as one token. Splitting on the last
      // space instead loses everything before it in `a file with spaces.txt`.
      const fields = record.split(' ')
      result.files.push({
        path: fields.slice(10).join(' '),
        unstaged: 'conflicted',
        submodule: fields[2] !== 'N...',
      })
      continue
    }

    if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const isRename = record.startsWith('2 ')
      const fields = record.split(' ')
      const xy = fields[1]
      const submodule = fields[2] !== 'N...'

      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` + `\0<origPath>`
      const scoreField = isRename ? fields[8] : undefined
      const pathStart = isRename ? 9 : 8
      const path = fields.slice(pathStart).join(' ')

      const file: ChangedFile = {
        path,
        staged: kindOf(xy[0]),
        unstaged: kindOf(xy[1]),
        submodule,
      }

      if (isRename) {
        file.similarity = Number.parseInt(scoreField?.slice(1) ?? '', 10) || undefined
        file.oldPath = records[++i]
      }

      result.files.push(file)
    }
  }

  return result
}

function readHeader(record: string, into: RepoStatus): void {
  const [, key, ...rest] = record.split(' ')
  const value = rest.join(' ')

  switch (key) {
    case 'branch.head':
      // git writes the literal "(detached)" here rather than omitting the line.
      if (value === '(detached)')
        into.detached = true
      else
        into.branch = value
      break
    case 'branch.oid':
      if (into.detached)
        into.branch = value.slice(0, 7)
      break
    case 'branch.upstream':
      into.upstream = value
      break
    case 'branch.ab': {
      // "+2 -1" — always both, always signed.
      const match = value.match(/^\+(\d+) -(\d+)$/)
      if (match) {
        into.ahead = Number.parseInt(match[1], 10)
        into.behind = Number.parseInt(match[2], 10)
      }
      break
    }
  }
}
