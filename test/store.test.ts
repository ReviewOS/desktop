/**
 * The store is also the API's allow-list, so which repository a request
 * resolves to is a correctness question and not just a convenience.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoStore } from '../src/server/store'

const files: string[] = []

function store(): RepoStore {
  const file = join(tmpdir(), `reviewos-store-${crypto.randomUUID()}.json`)
  files.push(file)
  return new RepoStore(file)
}

afterEach(() => {
  // Only the files this test made, by the names it made them with.
  while (files.length) {
    const file = files.pop()!
    rmSync(file, { force: true })
  }
})

describe('RepoStore.resolve', () => {
  it('matches an exact root', async () => {
    const repos = store()
    await repos.add({ root: '/one', name: 'one', empty: false })
    expect(repos.resolve('/one')).toBe('/one')
  })

  it('maps a path inside a repository to its root', async () => {
    // So the UI can pass a file path without first mapping it back itself.
    const repos = store()
    await repos.add({ root: '/one', name: 'one', empty: false })
    expect(repos.resolve('/one/src/a.ts')).toBe('/one')
  })

  it('refuses a path that is not in any open repository', async () => {
    const repos = store()
    await repos.add({ root: '/one', name: 'one', empty: false })
    expect(repos.resolve('/etc')).toBeNull()
  })

  it('does not match a sibling that merely shares a prefix', async () => {
    // `/one-other` starts with `/one` as a string but is a different
    // directory; a plain startsWith would hand git the wrong repository.
    const repos = store()
    await repos.add({ root: '/one', name: 'one', empty: false })
    expect(repos.resolve('/one-other/src/a.ts')).toBeNull()
  })

  it('normalises before comparing', async () => {
    const repos = store()
    await repos.add({ root: '/one', name: 'one', empty: false })
    expect(repos.resolve('/one/src/..')).toBe('/one')
  })
})

describe('RepoStore.list', () => {
  it('returns the most recently opened first', async () => {
    const repos = store()
    await repos.add({ root: '/old', name: 'old', empty: false })
    await new Promise(resolve => setTimeout(resolve, 2))
    await repos.add({ root: '/new', name: 'new', empty: false })

    expect((await repos.list()).map(entry => entry.root)).toEqual(['/new', '/old'])
  })

  it('survives a corrupt state file rather than refusing to start', async () => {
    const file = join(tmpdir(), `reviewos-store-${crypto.randomUUID()}.json`)
    files.push(file)
    await Bun.write(file, 'not json at all')

    const repos = new RepoStore(file)
    expect(await repos.list()).toEqual([])
  })
})
