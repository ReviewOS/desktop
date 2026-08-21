/**
 * The session decides what a commit contains, so its rules are the ones that
 * can lose someone's work if they are wrong.
 */
import { describe, expect, it } from 'bun:test'
import { Session } from '../src/server/session'

describe('Session: what a commit includes', () => {
  it('includes everything until the user touches a checkbox', () => {
    // The common case is "commit everything", and it should cost zero clicks.
    const session = new Session()
    expect(session.stagedPaths(['a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts'])
  })

  it('honours the selection once one box has been touched', () => {
    const session = new Session()
    session.toggleStaged('a.ts', true)
    expect(session.stagedPaths(['a.ts', 'b.ts'])).toEqual(['a.ts'])
  })

  it('treats unchecking everything as meaning nothing', () => {
    // The dangerous case: "no selection" must not fall back to "everything",
    // or unchecking the last box would commit the whole tree.
    const session = new Session()
    session.toggleStaged('a.ts', true)
    session.toggleStaged('a.ts', false)
    expect(session.stagedPaths(['a.ts', 'b.ts'])).toEqual([])
  })

  it('never returns a path that is no longer changed', () => {
    const session = new Session()
    session.setStaged(['a.ts', 'gone.ts'])
    expect(session.stagedPaths(['a.ts', 'b.ts'])).toEqual(['a.ts'])
  })
})

describe('Session: switching repository', () => {
  it('clears selections that belonged to the previous repository', () => {
    // A path from the old repo handed to git in the new one either errors or,
    // worse, matches a file that happens to share the name.
    const session = new Session()
    session.openRepo('/one')
    session.selectPath('src/a.ts')
    session.selectCommit('abc')
    session.toggleStaged('src/a.ts', true)

    session.openRepo('/two')

    expect(session.state.repo).toBe('/two')
    expect(session.state.path).toBeNull()
    expect(session.state.commit).toBeNull()
    expect(session.stagedPaths(['src/a.ts'])).toEqual(['src/a.ts'])
  })

  it('does not clear anything when reopening the same repository', () => {
    const session = new Session()
    session.openRepo('/one')
    session.selectPath('src/a.ts')
    session.openRepo('/one')
    expect(session.state.path).toBe('src/a.ts')
  })
})

describe('Session: reconciling with the working tree', () => {
  it('drops a selected file that is no longer changed', () => {
    // Committing or discarding removes a file from the change set while it is
    // still selected; leaving it selected renders a diff of nothing.
    const session = new Session()
    session.selectPath('a.ts')
    session.reconcile(['b.ts'])
    expect(session.state.path).toBeNull()
  })

  it('keeps a selected file that is still changed', () => {
    const session = new Session()
    session.selectPath('a.ts')
    session.reconcile(['a.ts', 'b.ts'])
    expect(session.state.path).toBe('a.ts')
  })

  it('forgets checked paths that have gone away', () => {
    const session = new Session()
    session.setStaged(['a.ts', 'b.ts'])
    session.reconcile(['a.ts'])
    expect(session.state.staged.has('b.ts')).toBe(false)
  })

  it('leaves the selected commit alone', () => {
    // History is not the working tree — a commit does not stop existing
    // because a file was staged.
    const session = new Session()
    session.selectCommit('abc123')
    session.reconcile([])
    expect(session.state.commit).toBe('abc123')
  })
})
