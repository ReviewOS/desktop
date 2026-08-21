/**
 * Running git.
 *
 * Every git call in the app funnels through here so there is exactly one place
 * that knows how the child process is configured — and so no call site is
 * tempted to build a shell string. `Bun.spawn` takes an argv array, so a branch
 * called `--upload-pack=…` or a path with a space is an argument, never syntax.
 */

/** A git invocation that exited non-zero, carrying what git wrote to stderr. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} exited ${exitCode}: ${stderr.trim() || '(no output)'}`)
    this.name = 'GitError'
  }
}

export interface GitRunOptions {
  /** Treat a non-zero exit as data rather than an error (e.g. `diff --quiet`). */
  allowFailure?: boolean
  /** Bytes of stdin to write, for `commit -F -` and friends. */
  stdin?: string
}

export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * The environment git runs in.
 *
 * Locale is pinned because several porcelain-adjacent commands still emit
 * localized text, and an app that parses "ahead 2" must not depend on the
 * user's language. Pagers and prompts are disabled outright: a pager would
 * block forever with no tty attached, and a credential prompt would do the
 * same on a fetch from a repo whose remote wants a password.
 */
const GIT_ENV: Record<string, string> = {
  ...process.env as Record<string, string>,
  LC_ALL: 'C',
  LANG: 'C',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
}

export async function git(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: GIT_ENV,
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Drained concurrently with the exit wait. A large `git diff` easily exceeds
  // the pipe buffer, and awaiting the exit first would deadlock on git blocking
  // in write() while nothing reads.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0 && !options.allowFailure)
    throw new GitError(args, exitCode, stderr)

  return { stdout, stderr, exitCode }
}

/** `git …` for the common case: succeed, and hand back trimmed stdout. */
export async function gitText(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await git(cwd, args)
  return stdout.trimEnd()
}

/**
 * Split output written with `-z`.
 *
 * git's NUL-separated formats terminate every record, so the split leaves a
 * trailing empty string that is a delimiter artifact rather than a record.
 */
export function splitNul(output: string): string[] {
  const parts = output.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '')
    parts.pop()
  return parts
}
