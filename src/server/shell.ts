/**
 * Turning repository state into the props the views take.
 *
 * All of the shaping lives here rather than in the templates. A `.stx` server
 * script can do this work, but then it can only be tested by rendering a page;
 * as plain functions it is testable directly, and the templates stay markup.
 */
import type { Commit } from '../git/log'
import type { FileDiff } from '../git/diff'
import type { ChangedFile, RepoStatus } from '../git/status'
import type { Branch, Remote, Worktree } from '../git/repo'
import type { StoredRepo } from './store'
import type { Session, Tab } from './session'

/** A row in the middle pane. Changed files and commits share the shape. */
export interface ListRow {
  id: string
  label: string
  /** Second line — the directory for a file, the author and date for a commit. */
  detail: string
  icon: string
  iconColor?: string
  /** Single-letter status badge (A/M/D/R) for a changed file. */
  badge?: string
  selected: boolean
  /** Present only in the Changes tab. */
  checked?: boolean
  additions?: number
  deletions?: number
}

export interface ToolbarItem {
  id: string
  icon: string
  /** The small gray line above the value. */
  label: string
  value: string
  /** Trailing text, e.g. "Last fetched 15 minutes ago". */
  detail?: string
  /** Whether the control opens a menu. */
  menu: boolean
}

export interface CommitSummary {
  /** How many files a commit would include, for the button's label. */
  count: number
  branch: string
  /** Nothing to commit — the button is disabled and says so. */
  clean: boolean
}

/**
 * macOS system colors, keyed by what the row means rather than by hue, so the
 * mapping is stated once and every pane agrees.
 */
const STATUS_COLOR: Record<string, string> = {
  added: 'green',
  modified: 'yellow',
  deleted: 'red',
  renamed: 'blue',
  copied: 'blue',
  untracked: 'gray',
  conflicted: 'orange',
  typechange: 'purple',
}

const STATUS_BADGE: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  conflicted: '!',
  typechange: 'T',
}

/** The change a row should show: staged if there is one, else unstaged. */
export function effectiveChange(file: ChangedFile): string {
  return file.staged ?? file.unstaged ?? 'modified'
}

export function fileRow(file: ChangedFile, selected: boolean, checked: boolean): ListRow {
  const change = effectiveChange(file)
  const slash = file.path.lastIndexOf('/')

  return {
    id: file.path,
    label: file.path.slice(slash + 1),
    // The directory, not the whole path — the filename is already the label,
    // and repeating it makes every row wrap in a 380px pane.
    detail: slash === -1 ? '' : file.path.slice(0, slash),
    icon: file.submodule ? 'i-f7-cube-box' : 'i-f7-doc-text',
    iconColor: STATUS_COLOR[change],
    badge: STATUS_BADGE[change],
    selected,
    checked,
  }
}

export function commitRow(commit: Commit, selected: boolean): ListRow {
  return {
    id: commit.hash,
    label: commit.subject,
    detail: `${commit.authorName} · ${relativeTime(new Date(commit.date))}`,
    icon: commit.merge ? 'i-f7-arrow-merge' : 'i-f7-circle-fill',
    iconColor: commit.merge ? 'purple' : 'blue',
    selected,
  }
}

/**
 * "15 minutes ago".
 *
 * Written out rather than pulled in, because the whole requirement is six
 * thresholds and a plural — and `Intl.RelativeTimeFormat` is in the runtime,
 * so the wording is still the platform's rather than invented here.
 */
export function relativeTime(when: Date, now: Date = new Date()): string {
  const seconds = Math.round((when.getTime() - now.getTime()) / 1000)
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  const thresholds: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
  ]

  let value = seconds
  for (const [unit, step] of thresholds) {
    if (Math.abs(value) < step)
      return format.format(value, unit)
    value = Math.round(value / step)
  }
  return format.format(value, 'year')
}

export interface ToolbarInput {
  repoName: string
  worktrees: Worktree[]
  activeWorktree?: Worktree
  status: RepoStatus
  remotes: Remote[]
  lastFetch: Date | null
}

export function toolbarItems(input: ToolbarInput): ToolbarItem[] {
  const { status, remotes, lastFetch } = input
  const remote = remotes[0]

  // The four controls in GitHub Desktop's chrome, in the same order and with
  // the same "what it is / what it's set to" two-line shape.
  const items: ToolbarItem[] = [
    {
      id: 'repository',
      icon: 'i-f7-book',
      label: 'Current Repository',
      value: input.repoName,
      menu: true,
    },
    {
      id: 'worktree',
      icon: 'i-f7-folder',
      label: 'Current Worktree',
      value: input.activeWorktree?.branch ?? input.activeWorktree?.path.split('/').pop() ?? input.repoName,
      menu: true,
    },
    {
      id: 'branch',
      icon: 'i-f7-arrow-branch',
      label: 'Current Branch',
      value: status.detached ? `${status.branch} (detached)` : status.branch,
      menu: true,
    },
  ]

  // The fetch control changes meaning with the branch's position relative to
  // its upstream, so its label is derived rather than fixed: pushing and
  // pulling are the same button in a different state.
  if (remote) {
    items.push({
      id: 'fetch',
      icon: status.ahead > 0
        ? 'i-f7-arrow-up-circle'
        : status.behind > 0 ? 'i-f7-arrow-down-circle' : 'i-f7-arrow-2-circlepath',
      label: status.ahead > 0
        ? `Push ${status.ahead} commit${status.ahead === 1 ? '' : 's'}`
        : status.behind > 0
          ? `Pull ${status.behind} commit${status.behind === 1 ? '' : 's'}`
          : `Fetch ${remote.name}`,
      value: status.upstream ?? 'No upstream',
      detail: lastFetch ? `Last fetched ${relativeTime(lastFetch)}` : 'Never fetched',
      menu: false,
    })
  }

  return items
}

export interface ShellInput {
  session: Session
  repos: StoredRepo[]
  status: RepoStatus
  branches: Branch[]
  worktrees: Worktree[]
  remotes: Remote[]
  lastFetch: Date | null
  commits: Commit[]
  diffFiles: FileDiff[]
}

export interface ShellProps {
  title: string
  spaces: unknown[]
  activeSpace: string
  toolbar: ToolbarItem[]
  tab: Tab
  listItems: ListRow[]
  diffFiles: FileDiff[]
  summary: CommitSummary
  hasRepo: boolean
}

/**
 * One space per repository — Arc's model, which happens to fit exactly.
 *
 * A space is a whole sidebar with its own color, and a repository is a whole
 * context with its own branches and history. Mapping one onto the other means
 * switching repositories is a swipe rather than a dropdown, and the panel's
 * tint tells you which one you are in before you read anything.
 */
export function repoSpaces(input: ShellInput): unknown[] {
  const { session, repos, status, branches: branchList } = input

  // A fixed rotation rather than a hash of the path: a stable, obviously
  // distinct set of hues beats a hash that can put two adjacent repos on
  // near-identical colors.
  const tints = ['blue', 'green', 'purple', 'orange', 'teal', 'pink', 'indigo', 'red']

  return repos.map((repo, index) => {
    const active = repo.root === session.state.repo
    const sections: unknown[] = []

    if (active) {
      sections.push({
        id: 'views',
        items: [
          {
            id: 'tab:changes',
            label: 'Changes',
            icon: 'i-f7-doc-on-doc',
            iconColor: tints[index % tints.length],
            count: status.files.length || undefined,
            active: session.state.tab === 'changes',
          },
          {
            id: 'tab:history',
            label: 'History',
            icon: 'i-f7-clock',
            iconColor: tints[index % tints.length],
            active: session.state.tab === 'history',
          },
        ],
      })

      const current = branchList.find(branch => branch.current)
      sections.push({
        id: 'branches',
        label: 'Branches',
        items: branchList.slice(0, 12).map(branch => ({
          id: `branch:${branch.name}`,
          label: branch.name,
          icon: branch.current ? 'i-f7-checkmark-alt-circle-fill' : 'i-f7-arrow-branch',
          iconColor: branch.current ? 'green' : undefined,
          // Ahead/behind is the only number worth the width here; a branch
          // level with its upstream shows nothing rather than "0".
          count: branch.ahead || branch.behind
            ? `${branch.ahead ? `↑${branch.ahead}` : ''}${branch.behind ? `↓${branch.behind}` : ''}`
            : undefined,
          // The checked-out branch, always. The condition here used to also
          // require `tab === 'branches'`, which is not a member of `Tab` and
          // only compiled because of a cast — so it was never true and the
          // current branch never rendered as selected.
          active: branch.name === current?.name,
        })),
      })
    }

    return {
      id: repo.root,
      label: repo.name,
      icon: 'i-f7-cube-box-fill',
      tint: tints[index % tints.length],
      sections,
      action: { id: `open:${repo.root}`, label: active ? 'New Branch' : `Open ${repo.name}` },
    }
  })
}

export function buildShell(input: ShellInput): ShellProps {
  const { session, status, commits, diffFiles } = input
  const paths = status.files.map(file => file.path)
  session.reconcile(paths)

  const staged = new Set(session.stagedPaths(paths))

  const listItems = session.state.tab === 'changes'
    ? status.files.map(file => fileRow(file, file.path === session.state.path, staged.has(file.path)))
    : commits.map(commit => commitRow(commit, commit.hash === session.state.commit))

  const repoName = input.repos.find(repo => repo.root === session.state.repo)?.name ?? 'ReviewOS'

  return {
    title: session.state.repo ? `${repoName} — ReviewOS` : 'ReviewOS',
    spaces: repoSpaces(input),
    activeSpace: session.state.repo ?? '',
    toolbar: session.state.repo
      ? toolbarItems({
          repoName,
          worktrees: input.worktrees,
          activeWorktree: input.worktrees.find(tree => tree.path === session.state.repo),
          status,
          remotes: input.remotes,
          lastFetch: input.lastFetch,
        })
      : [],
    tab: session.state.tab,
    listItems,
    diffFiles,
    summary: {
      count: staged.size,
      branch: status.branch,
      clean: status.files.length === 0,
    },
    hasRepo: session.state.repo !== null,
  }
}
