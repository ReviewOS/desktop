/**
 * The git layer, against a real repository built for the test.
 *
 * Fixtures rather than recorded output: the parsers exist to survive what git
 * actually prints, and a recording freezes one version's formatting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../src/git/exec'
import { diff, diffUntracked } from '../src/git/diff'
import { commitFiles, log } from '../src/git/log'
import { branches, open, worktrees } from '../src/git/repo'
import { status } from '../src/git/status'
import { commit, discard, setStagedPaths } from '../src/git/write'

let repo: string

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'reviewos-git-'))

  await git(repo, ['init', '--quiet', '--initial-branch=main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  // Signing would prompt, and the CI machine has no key.
  await git(repo, ['config', 'commit.gpgsign', 'false'])

  await Bun.write(join(repo, 'kept.ts'), 'one\ntwo\nthree\n')
  await Bun.write(join(repo, 'renamed-from.ts'), 'stable content here\nand a second line\n')
  await Bun.write(join(repo, 'deleted.ts'), 'goes away\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--quiet', '-m', 'first commit'])
})

afterAll(() => {
  // Only the directory this test made, by the name it made it with.
  if (repo?.includes('reviewos-git-'))
    rmSync(repo, { recursive: true, force: true })
})

describe('open', () => {
  it('resolves a repository root', async () => {
    const info = await open(repo)
    expect(info?.name).toBe(repo.split('/').pop())
    expect(info?.empty).toBe(false)
  })

  it('returns null outside a repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'reviewos-not-git-'))
    try {
      expect(await open(outside)).toBeNull()
    }
    finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('status', () => {
  it('reports the branch and a clean tree', async () => {
    const state = await status(repo)
    expect(state.branch).toBe('main')
    expect(state.detached).toBe(false)
    expect(state.files).toEqual([])
  })

  it('classifies each kind of change', async () => {
    await Bun.write(join(repo, 'kept.ts'), 'one\nTWO\nthree\n')
    await Bun.write(join(repo, 'brand-new.ts'), 'fresh\n')
    await git(repo, ['rm', '--quiet', 'deleted.ts'])
    await git(repo, ['mv', 'renamed-from.ts', 'renamed-to.ts'])

    const state = await status(repo)
    const byPath = new Map(state.files.map(file => [file.path, file]))

    expect(byPath.get('kept.ts')?.unstaged).toBe('modified')
    expect(byPath.get('brand-new.ts')?.unstaged).toBe('untracked')
    expect(byPath.get('deleted.ts')?.staged).toBe('deleted')

    // Rename detection is off by default in porcelain output. Without it a
    // moved file reads as an unrelated delete plus an unrelated add.
    const renamed = byPath.get('renamed-to.ts')
    expect(renamed?.staged).toBe('renamed')
    expect(renamed?.oldPath).toBe('renamed-from.ts')
  })

  it('reads a path containing a space', async () => {
    await Bun.write(join(repo, 'with space.ts'), 'x\n')
    const state = await status(repo)
    expect(state.files.some(file => file.path === 'with space.ts')).toBe(true)
  })

  it('reads a conflicted path containing spaces in full', async () => {
    // An unmerged record puts the path in field 10, and it is the only field
    // that can contain spaces. Taking the last space-separated token instead
    // reported `a merged file.txt` as `file.txt`, so selecting the row asked
    // git about a path that does not exist and the diff came back empty.
    const conflict = mkdtempSync(join(tmpdir(), 'reviewos-git-conflict-'))
    try {
      await git(conflict, ['init', '--quiet', '--initial-branch=main'])
      await git(conflict, ['config', 'user.email', 'test@example.com'])
      await git(conflict, ['config', 'user.name', 'Test'])
      await git(conflict, ['config', 'commit.gpgsign', 'false'])

      const name = 'a merged file.txt'
      await Bun.write(join(conflict, name), 'base\n')
      await git(conflict, ['add', '-A'])
      await git(conflict, ['commit', '--quiet', '-m', 'base'])

      await git(conflict, ['checkout', '--quiet', '-b', 'other'])
      await Bun.write(join(conflict, name), 'other\n')
      await git(conflict, ['commit', '--quiet', '-am', 'other'])

      await git(conflict, ['checkout', '--quiet', 'main'])
      await Bun.write(join(conflict, name), 'main\n')
      await git(conflict, ['commit', '--quiet', '-am', 'main'])

      // Merging conflicting edits is the point; a non-zero exit is expected.
      await git(conflict, ['merge', 'other'], { allowFailure: true })

      const state = await status(conflict)
      const conflicted = state.files.filter(file => file.unstaged === 'conflicted')
      expect(conflicted.map(file => file.path)).toEqual([name])
    }
    finally {
      if (conflict.includes('reviewos-git-conflict-'))
        rmSync(conflict, { recursive: true, force: true })
    }
  })
})

describe('diff', () => {
  it('produces hunks for a modified file', async () => {
    const [file] = await diff(repo, { path: 'kept.ts' })
    expect(file.path).toBe('kept.ts')
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(1)
  })

  it('renders an untracked file as all additions', async () => {
    // git has nothing to diff an untracked file against, so a plain `diff`
    // says nothing about it at all.
    const [file] = await diffUntracked(repo, 'brand-new.ts')
    expect(file.path).toBe('brand-new.ts')
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(0)
  })

  it('returns nothing for a path with no changes', async () => {
    expect(await diff(repo, { path: 'does-not-exist.ts' })).toEqual([])
  })
})

describe('staging and committing', () => {
  it('commits only the paths that were selected', async () => {
    await setStagedPaths(repo, ['kept.ts'])
    const result = await commit(repo, { summary: 'change kept', description: 'body text' })

    const files = await commitFiles(repo, result.hash)
    expect(files.map(file => file.path)).toEqual(['kept.ts'])

    // Everything else must still be waiting.
    const state = await status(repo)
    expect(state.files.some(file => file.path === 'brand-new.ts')).toBe(true)
  })

  it('unstages a path that is no longer selected', async () => {
    // The model is "the index should match the checked set", not "add what I
    // clicked" — so a second call with a different set has to remove the first.
    await setStagedPaths(repo, ['brand-new.ts'])
    await setStagedPaths(repo, ['with space.ts'])

    const state = await status(repo)
    expect(state.files.find(file => file.path === 'brand-new.ts')?.staged).toBeUndefined()
    expect(state.files.find(file => file.path === 'with space.ts')?.staged).toBe('added')
  })

  it('keeps a message that would break a command line', async () => {
    // The message goes in on stdin, so quotes, backticks and a leading dash
    // are just bytes.
    await setStagedPaths(repo, ['with space.ts'])
    const summary = `fix: don't "quote" \`this\` --now`
    const result = await commit(repo, { summary })

    const [head] = await log(repo, { limit: 1 })
    expect(head.subject).toBe(summary)
    expect(head.hash).toBe(result.hash)
  })

  it('refuses an empty summary', async () => {
    await expect(commit(repo, { summary: '   ' })).rejects.toThrow(/summary/i)
  })
})

describe('log', () => {
  it('reads subject, author and refs', async () => {
    const commits = await log(repo, { limit: 10 })
    expect(commits.length).toBeGreaterThanOrEqual(2)

    const first = commits.at(-1)!
    expect(first.subject).toBe('first commit')
    expect(first.authorName).toBe('Test')
    expect(first.parents).toEqual([])
    expect(first.merge).toBe(false)

    expect(commits[0].refs).toContain('HEAD -> main')
  })

  it('keeps a multi-line body out of the subject', async () => {
    await Bun.write(join(repo, 'kept.ts'), 'one\nTWO\nTHREE\n')
    await setStagedPaths(repo, ['kept.ts'])
    await commit(repo, { summary: 'subject line', description: 'first para\n\nsecond para' })

    const [head] = await log(repo, { limit: 1 })
    expect(head.subject).toBe('subject line')
    expect(head.body).toBe('first para\n\nsecond para')
  })
})

describe('branches and worktrees', () => {
  it('marks the current branch', async () => {
    await git(repo, ['branch', 'feature'])
    const list = await branches(repo)

    expect(list.find(branch => branch.name === 'main')?.current).toBe(true)
    expect(list.find(branch => branch.name === 'feature')?.current).toBe(false)
  })

  it('lists the main worktree', async () => {
    const trees = await worktrees(repo)
    expect(trees[0].main).toBe(true)
    expect(trees[0].branch).toBe('main')
  })
})

describe('discard', () => {
  it('restores a tracked file', async () => {
    await Bun.write(join(repo, 'kept.ts'), 'wrecked\n')
    await discard(repo, 'kept.ts')
    expect(await Bun.file(join(repo, 'kept.ts')).text()).toBe('one\nTWO\nTHREE\n')
  })

  it('removes an untracked file', async () => {
    await Bun.write(join(repo, 'scratch.ts'), 'temp\n')
    await discard(repo, 'scratch.ts')
    expect(await Bun.file(join(repo, 'scratch.ts')).exists()).toBe(false)
  })
})
