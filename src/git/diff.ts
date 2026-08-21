/**
 * Unified diffs, parsed into something a renderer can lay out.
 *
 * The parser is deliberately structural rather than line-oriented: the view
 * needs old and new line numbers per row (the gutter in the screenshot), which
 * you cannot recover from a raw diff without walking hunk headers and counting.
 * Doing that once here beats doing it again in every renderer.
 */
import { git } from './exec'

export type DiffLineKind = 'context' | 'add' | 'delete' | 'no-newline'

export interface DiffLine {
  kind: DiffLineKind
  /** Line number in the pre-image. Absent on added lines. */
  oldNumber?: number
  /** Line number in the post-image. Absent on deleted lines. */
  newNumber?: number
  /** Content with the leading +/-/space marker stripped. */
  text: string
}

export interface DiffHunk {
  /** The `@@ … @@` line verbatim, including any trailing section heading. */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath?: string
  /** True when git declined to produce a textual diff. */
  binary: boolean
  /** File mode changed (e.g. chmod +x) without content changing. */
  modeChange?: { from: string, to: string }
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

export interface DiffOptions {
  /** Diff the index against HEAD instead of the worktree against the index. */
  staged?: boolean
  /** Restrict to one path. */
  path?: string
  /** Lines of context around each change. */
  context?: number
  /** Diff this commit against its first parent instead of the working tree. */
  commit?: string
}

export async function diff(repo: string, options: DiffOptions = {}): Promise<FileDiff[]> {
  const args = options.commit
    ? ['show', '--format=', options.commit]
    : ['diff', ...(options.staged ? ['--cached'] : [])]

  args.push(
    `--unified=${options.context ?? 3}`,
    '--find-renames',
    // Without this, a file whose only change is its mode produces no header
    // at all in some git versions, so a chmod looks like nothing happened.
    '--patch',
    // Colors and pager settings leak in from the user's gitconfig otherwise,
    // and ANSI escapes in the payload would be rendered as literal text.
    '--no-color',
    '--no-ext-diff',
  )

  if (options.path)
    args.push('--', options.path)

  const { stdout, exitCode } = await git(repo, args, { allowFailure: true })
  // `diff` exits 0 with no changes and non-zero only on real errors, but an
  // empty repo or a bad path should render as "nothing" rather than throw.
  if (exitCode !== 0 && !stdout)
    return []

  return parseUnifiedDiff(stdout)
}

/** The untracked case: git has nothing to diff against, so synthesize one. */
export async function diffUntracked(repo: string, path: string): Promise<FileDiff[]> {
  // `--no-index` against /dev/null is how git itself renders a new file, so
  // the output goes through the identical parser rather than a parallel path
  // that would drift. It exits 1 whenever there IS a difference, which here is
  // always — that is success, not failure.
  const { stdout } = await git(repo, [
    'diff', '--no-index', '--no-color', '--no-ext-diff', '--patch', '--', '/dev/null', path,
  ], { allowFailure: true })

  const parsed = parseUnifiedDiff(stdout)
  // `--no-index` writes the path as given on the command line; normalize it
  // back to the repo-relative path the rest of the app uses.
  for (const file of parsed)
    file.path = path
  return parsed
}

export function parseUnifiedDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: DiffHunk | null = null
  let oldNumber = 0
  let newNumber = 0

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: '', binary: false, hunks: [], additions: 0, deletions: 0 }
      hunk = null
      files.push(file)
      continue
    }

    if (!file)
      continue

    // Header lines. Paths come from `---`/`+++` rather than the `diff --git`
    // line, because that line quotes and escapes paths containing spaces while
    // the marker lines give them with a single `a/` or `b/` prefix.
    if (line.startsWith('--- ')) {
      const path = stripPrefix(line.slice(4))
      if (path)
        file.oldPath = path
      continue
    }
    if (line.startsWith('+++ ')) {
      const path = stripPrefix(line.slice(4))
      if (path)
        file.path = path
      continue
    }
    if (line.startsWith('rename from ')) {
      file.oldPath = line.slice(12)
      continue
    }
    if (line.startsWith('rename to ')) {
      file.path = line.slice(10)
      continue
    }
    if (line.startsWith('old mode ')) {
      file.modeChange = { from: line.slice(9).trim(), to: '' }
      continue
    }
    if (line.startsWith('new mode ') && file.modeChange) {
      file.modeChange.to = line.slice(9).trim()
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
      continue
    }

    if (line.startsWith('@@')) {
      const parsed = parseHunkHeader(line)
      if (!parsed)
        continue
      hunk = parsed
      file.hunks.push(hunk)
      oldNumber = hunk.oldStart
      newNumber = hunk.newStart
      continue
    }

    if (!hunk)
      continue

    // `\ No newline at end of file` annotates the line above it and occupies no
    // position in either file, so it must not advance either counter.
    if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'no-newline', text: line.slice(2) })
      continue
    }

    const marker = line[0]
    const text = line.slice(1)

    if (marker === '+') {
      hunk.lines.push({ kind: 'add', newNumber: newNumber++, text })
      file.additions++
    }
    else if (marker === '-') {
      hunk.lines.push({ kind: 'delete', oldNumber: oldNumber++, text })
      file.deletions++
    }
    else if (marker === ' ') {
      hunk.lines.push({ kind: 'context', oldNumber: oldNumber++, newNumber: newNumber++, text })
    }
    // Anything else is trailing junk after the last hunk (an empty final line
    // from the split, most often) and is dropped.
  }

  // A pure rename or mode change has no `+++` line carrying a real path.
  for (const entry of files) {
    if (!entry.path && entry.oldPath)
      entry.path = entry.oldPath
    if (entry.oldPath === entry.path)
      entry.oldPath = undefined
  }

  return files
}

/** `a/src/foo.ts` → `src/foo.ts`; `/dev/null` → empty, meaning "no such side". */
function stripPrefix(raw: string): string {
  // git tab-terminates the path when it contains trailing whitespace.
  const path = raw.split('\t')[0]
  if (path === '/dev/null')
    return ''
  if (path.startsWith('a/') || path.startsWith('b/'))
    return path.slice(2)
  return path
}

function parseHunkHeader(line: string): DiffHunk | null {
  // `@@ -oldStart,oldLines +newStart,newLines @@ optional section heading`
  // The counts are omitted when they are 1, which is why they are optional here.
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!match)
    return null

  return {
    header: line,
    oldStart: Number.parseInt(match[1], 10),
    oldLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3], 10),
    newLines: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
    lines: [],
  }
}
