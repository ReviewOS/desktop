/**
 * The diff parser is the piece with the most ways to be quietly wrong: a
 * miscounted hunk header shifts every line number after it, and the result
 * still looks like a diff.
 */
import { describe, expect, it } from 'bun:test'
import { parseUnifiedDiff } from '../src/git/diff'

describe('parseUnifiedDiff: line numbering', () => {
  it('numbers both sides through a hunk', () => {
    const [file] = parseUnifiedDiff([
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,4 +10,5 @@',
      ' keep one',
      '-drop',
      '+add one',
      '+add two',
      ' keep two',
      '',
    ].join('\n'))

    expect(file.path).toBe('src/a.ts')
    expect(file.additions).toBe(2)
    expect(file.deletions).toBe(1)

    expect(file.hunks[0].lines.map(line => [line.kind, line.oldNumber, line.newNumber])).toEqual([
      ['context', 10, 10],
      ['delete', 11, undefined],
      ['add', undefined, 11],
      ['add', undefined, 12],
      // The context line after the change sits at 12 in the old file and 13 in
      // the new one — the whole point of carrying two counters.
      ['context', 12, 13],
    ])
  })

  it('treats an omitted count as 1', () => {
    // git writes `@@ -1 +1 @@` rather than `@@ -1,1 +1,1 @@`.
    const [file] = parseUnifiedDiff([
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -5 +5 @@',
      '-old',
      '+new',
      '',
    ].join('\n'))

    expect(file.hunks[0].oldLines).toBe(1)
    expect(file.hunks[0].newLines).toBe(1)
    expect(file.hunks[0].lines[0].oldNumber).toBe(5)
    expect(file.hunks[0].lines[1].newNumber).toBe(5)
  })

  it('does not let the no-newline marker advance either counter', () => {
    // `\ No newline at end of file` annotates the line above it and occupies
    // no position in either file. Counting it shifts everything after.
    const [file] = parseUnifiedDiff([
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -1,2 +1,2 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      ' tail',
      '',
    ].join('\n'))

    const lines = file.hunks[0].lines
    expect(lines[1].kind).toBe('no-newline')
    expect(lines[2]).toEqual({ kind: 'add', newNumber: 1, text: 'new' })
    expect(lines[3]).toEqual({ kind: 'context', oldNumber: 2, newNumber: 2, text: 'tail' })
  })

  it('keeps counting across several hunks', () => {
    const [file] = parseUnifiedDiff([
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+TWO',
      '@@ -50,2 +50,2 @@',
      ' fifty',
      '+added',
      '',
    ].join('\n'))

    expect(file.hunks).toHaveLength(2)
    // The second hunk restarts at its own header rather than continuing.
    expect(file.hunks[1].lines[0].oldNumber).toBe(50)
    expect(file.hunks[1].lines[1].newNumber).toBe(51)
  })
})

describe('parseUnifiedDiff: file headers', () => {
  it('reads a rename', () => {
    const [file] = parseUnifiedDiff([
      'diff --git a/old.ts b/new.ts',
      'similarity index 92%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n'))

    expect(file.oldPath).toBe('old.ts')
    expect(file.path).toBe('new.ts')
  })

  it('does not report an old path when nothing moved', () => {
    // `--- a/x` and `+++ b/x` name the same file; surfacing "x → x" in the
    // header would be noise on every ordinary modification.
    const [file] = parseUnifiedDiff([
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n'))

    expect(file.oldPath).toBeUndefined()
    expect(file.path).toBe('x.ts')
  })

  it('reads a new file, whose old side is /dev/null', () => {
    const [file] = parseUnifiedDiff([
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      '',
    ].join('\n'))

    expect(file.oldPath).toBeUndefined()
    expect(file.path).toBe('new.ts')
    expect(file.additions).toBe(2)
  })

  it('reads a deletion, whose new side is /dev/null', () => {
    const [file] = parseUnifiedDiff([
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      '',
    ].join('\n'))

    // With no `+++` path, the old path is what the file is called.
    expect(file.path).toBe('gone.ts')
    expect(file.deletions).toBe(2)
  })

  it('flags a binary file rather than pretending it has hunks', () => {
    const [file] = parseUnifiedDiff([
      'diff --git a/logo.png b/logo.png',
      'index 1234567..89abcde 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n'))

    expect(file.binary).toBe(true)
    expect(file.hunks).toHaveLength(0)
  })

  it('reads a mode change with no content change', () => {
    const [file] = parseUnifiedDiff([
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n'))

    expect(file.modeChange).toEqual({ from: '100644', to: '100755' })
    expect(file.hunks).toHaveLength(0)
  })

  it('separates several files in one patch', () => {
    const files = parseUnifiedDiff([
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+A',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-b',
      '+B',
      '',
    ].join('\n'))

    expect(files.map(file => file.path)).toEqual(['a.ts', 'b.ts'])
    expect(files.every(file => file.hunks.length === 1)).toBe(true)
  })

  it('reads a path containing a space', () => {
    const [file] = parseUnifiedDiff([
      'diff --git a/my docs/read me.md b/my docs/read me.md',
      '--- a/my docs/read me.md',
      '+++ b/my docs/read me.md',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n'))

    // Taken from the `+++` marker, not from the `diff --git` line, which
    // quotes and escapes paths.
    expect(file.path).toBe('my docs/read me.md')
  })

  it('returns nothing for an empty patch', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})
