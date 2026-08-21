/**
 * The shaping between git's answers and the props the views take.
 */
import { describe, expect, it } from 'bun:test'
import type { ChangedFile, RepoStatus } from '../src/git/status'
import { commitRow, effectiveChange, fileRow, relativeTime, toolbarItems } from '../src/server/shell'

const clean: RepoStatus = { branch: 'main', ahead: 0, behind: 0, detached: false, files: [] }

function changed(overrides: Partial<ChangedFile>): ChangedFile {
  return { path: 'a.ts', submodule: false, ...overrides }
}

describe('effectiveChange', () => {
  it('prefers the staged change when a file has both', () => {
    // A file staged as added and then modified in the worktree is, to the
    // list, an added file — that is what a commit would record.
    expect(effectiveChange(changed({ staged: 'added', unstaged: 'modified' }))).toBe('added')
  })

  it('falls back to the worktree change', () => {
    expect(effectiveChange(changed({ unstaged: 'deleted' }))).toBe('deleted')
  })
})

describe('fileRow', () => {
  it('splits the path into a filename and its directory', () => {
    // Repeating the full path under the filename makes every row wrap in a
    // 380px pane.
    const row = fileRow(changed({ path: 'src/server/api.ts', unstaged: 'modified' }), false, true)
    expect(row.label).toBe('api.ts')
    expect(row.detail).toBe('src/server')
  })

  it('leaves the detail empty for a file at the root', () => {
    const row = fileRow(changed({ path: 'README.md', unstaged: 'modified' }), false, true)
    expect(row.label).toBe('README.md')
    expect(row.detail).toBe('')
  })

  it('badges each kind of change distinctly', () => {
    const badge = (file: Partial<ChangedFile>) => fileRow(changed(file), false, true).badge
    expect(badge({ staged: 'added' })).toBe('A')
    expect(badge({ unstaged: 'modified' })).toBe('M')
    expect(badge({ staged: 'deleted' })).toBe('D')
    expect(badge({ staged: 'renamed' })).toBe('R')
    expect(badge({ unstaged: 'untracked' })).toBe('U')
    expect(badge({ unstaged: 'conflicted' })).toBe('!')
  })

  it('marks a submodule with its own icon', () => {
    expect(fileRow(changed({ submodule: true, unstaged: 'modified' }), false, true).icon).toBe('i-f7-cube-box')
  })
})

describe('commitRow', () => {
  it('shows the author and how long ago', () => {
    const row = commitRow({
      hash: 'a'.repeat(40),
      short: 'aaaaaaa',
      authorName: 'Chris',
      authorEmail: 'c@example.com',
      date: new Date(Date.now() - 3600_000).toISOString(),
      subject: 'fix the thing',
      body: '',
      parents: ['b'.repeat(40)],
      refs: [],
      merge: false,
    }, true)

    expect(row.label).toBe('fix the thing')
    expect(row.detail).toBe('Chris · 1 hour ago')
    expect(row.selected).toBe(true)
  })

  it('distinguishes a merge', () => {
    const base = {
      hash: 'a'.repeat(40),
      short: 'aaaaaaa',
      authorName: 'Chris',
      authorEmail: 'c@example.com',
      date: new Date().toISOString(),
      subject: 'merge',
      body: '',
      refs: [],
    }
    expect(commitRow({ ...base, parents: ['b', 'c'], merge: true }, false).icon).toBe('i-f7-arrow-merge')
    expect(commitRow({ ...base, parents: ['b'], merge: false }, false).icon).toBe('i-f7-circle-fill')
  })
})

describe('relativeTime', () => {
  const now = new Date('2026-08-20T12:00:00Z')

  it('describes the recent past the way the chrome does', () => {
    expect(relativeTime(new Date('2026-08-20T11:45:00Z'), now)).toBe('15 minutes ago')
    expect(relativeTime(new Date('2026-08-20T09:00:00Z'), now)).toBe('3 hours ago')
    expect(relativeTime(new Date('2026-08-17T12:00:00Z'), now)).toBe('3 days ago')
  })

  it('reaches years without falling apart', () => {
    expect(relativeTime(new Date('2024-08-20T12:00:00Z'), now)).toBe('2 years ago')
  })
})

describe('toolbarItems', () => {
  const base = {
    repoName: 'reviewos.org',
    worktrees: [],
    status: clean,
    remotes: [{ name: 'origin', fetchUrl: 'git@example.com:o/r.git', pushUrl: 'git@example.com:o/r.git' }],
    lastFetch: null,
  }

  it('renders the four controls in the order GitHub Desktop uses', () => {
    const items = toolbarItems(base)
    expect(items.map(item => item.id)).toEqual(['repository', 'worktree', 'branch', 'fetch'])
  })

  it('says fetch when the branch is level with its upstream', () => {
    const [, , , fetch] = toolbarItems({ ...base, status: { ...clean, upstream: 'origin/main' } })
    expect(fetch.label).toBe('Fetch origin')
    expect(fetch.value).toBe('origin/main')
  })

  it('says push when the branch is ahead', () => {
    // The same control means different things depending on where the branch
    // sits, which is why the label is derived rather than fixed.
    const [, , , fetch] = toolbarItems({ ...base, status: { ...clean, ahead: 2, upstream: 'origin/main' } })
    expect(fetch.label).toBe('Push 2 commits')
  })

  it('says pull when the branch is behind', () => {
    const [, , , fetch] = toolbarItems({ ...base, status: { ...clean, behind: 1, upstream: 'origin/main' } })
    expect(fetch.label).toBe('Pull 1 commit')
  })

  it('omits the fetch control when there is no remote', () => {
    expect(toolbarItems({ ...base, remotes: [] }).map(item => item.id)).toEqual(['repository', 'worktree', 'branch'])
  })

  it('marks a detached HEAD', () => {
    const [, , branch] = toolbarItems({ ...base, status: { ...clean, branch: 'a1b2c3d', detached: true } })
    expect(branch.value).toBe('a1b2c3d (detached)')
  })

  it('says so when the repository has never been fetched', () => {
    const [, , , fetch] = toolbarItems(base)
    expect(fetch.detail).toBe('Never fetched')
  })
})
