/**
 * The shaping behind the pane that replaces an empty diff, and the tint that
 * ties a repository to its colour.
 */
import { describe, expect, it } from 'bun:test'
import type { RepoStatus } from '../src/git/status'
import { repoShortcuts, tintFor } from '../src/server/shell'

const clean: RepoStatus = { branch: 'main', ahead: 0, behind: 0, detached: false, files: [] }

function shortcuts(overrides: { status?: Partial<RepoStatus>, remotes?: unknown[] } = {}) {
  return repoShortcuts({
    session: {} as never,
    repos: [],
    status: { ...clean, ...overrides.status },
    branches: [],
    worktrees: [],
    remotes: (overrides.remotes ?? [{ name: 'origin', fetchUrl: '', pushUrl: '' }]) as never,
    lastFetch: null,
    commits: [],
    diffFiles: [],
  }) as Array<{ id: string, label: string, icon: string, iconColor?: string }>
}

describe('tintFor', () => {
  it('gives each repository a distinct hue', () => {
    // A fixed rotation, not a hash of the path: a hash can put two adjacent
    // repositories on near-identical colours, which defeats the point of
    // colouring them at all.
    expect(new Set([0, 1, 2, 3].map(tintFor)).size).toBe(4)
  })

  it('is stable for a given position', () => {
    expect(tintFor(2)).toBe(tintFor(2))
  })

  it('wraps rather than running out', () => {
    expect(tintFor(0)).toBe(tintFor(8))
    expect(typeof tintFor(99)).toBe('string')
  })
})

describe('repoShortcuts: the pinned grid', () => {
  it('fills the row, because a short row reads as a failed load', () => {
    expect(shortcuts()).toHaveLength(4)
  })

  it('gives every tile a colour', () => {
    // Four grey glyphs in four grey boxes read as four empty boxes, however
    // well proportioned.
    for (const tile of shortcuts())
      expect(tile.iconColor).toBeTruthy()
  })

  it('says fetch when the branch is level', () => {
    const [fetch] = shortcuts()
    expect(fetch.label).toBe('Fetch')
  })

  it('says push, with a count, when the branch is ahead', () => {
    const [fetch] = shortcuts({ status: { ahead: 3 } })
    expect(fetch.label).toBe('Push 3')
    expect(fetch.icon).toContain('arrow-up')
  })

  it('says pull, with a count, when the branch is behind', () => {
    const [fetch] = shortcuts({ status: { behind: 2 } })
    expect(fetch.label).toBe('Pull 2')
    expect(fetch.icon).toContain('arrow-down')
  })

  it('prefers push when the branch has diverged', () => {
    // Pushing is what the user can actually do next; a pull is a merge
    // decision and belongs behind a deliberate click, not a tile that
    // relabels itself into one.
    const [fetch] = shortcuts({ status: { ahead: 1, behind: 1 } })
    expect(fetch.label).toBe('Push 1')
  })

  it('says so when there is no remote to fetch from', () => {
    const [fetch] = shortcuts({ remotes: [] })
    expect(fetch.label).toBe('No remote')
    expect(fetch.iconColor).toBe('gray')
  })
})
