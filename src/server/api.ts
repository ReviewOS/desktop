/**
 * The HTTP surface the webview talks to.
 *
 * A local server rather than a Craft JS bridge call per operation: git output
 * is measured in megabytes for a large diff, the bridge serializes through a
 * string channel, and `fetch` from the page gives streaming, caching and
 * cancellation for free. The server binds to loopback only — see `listen()`.
 */
import type { Session } from './session'
import type { RepoStore } from './store'
import { diff, diffUntracked } from '../git/diff'
import { commitFiles, log } from '../git/log'
import { branches, lastFetch, open, remotes, worktrees } from '../git/repo'
import { status } from '../git/status'
import { checkout, commit, discard, fetch as gitFetch, setStagedPaths } from '../git/write'

export type ApiHandler = (request: Request) => Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/**
 * Turn a thrown error into a response the UI can show.
 *
 * git's stderr is the useful part of almost every failure ("pathspec did not
 * match", "Authentication failed"), so it is passed through rather than
 * replaced with a generic message. It is displayed as text, never as HTML.
 */
function failure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return json({ error: message }, 400)
}

export function createApi(store: RepoStore, session: Session): ApiHandler {
  /**
   * Resolve the repository a request is about.
   *
   * The path comes from the query string, and is checked against the set the
   * user has actually opened rather than used directly — otherwise any page
   * loaded in the webview could name an arbitrary directory and have the
   * server run git in it.
   */
  function repoFrom(url: URL): string {
    const requested = url.searchParams.get('repo')
    const resolved = store.resolve(requested)
    if (!resolved)
      throw new Error(requested ? `${requested} is not an open repository.` : 'No repository is open.')
    return resolved
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const route = url.pathname.replace(/^\/api\//, '')

    try {
      switch (`${request.method} ${route}`) {
        case 'GET repos':
          return json({ repos: await store.list() })

        case 'POST repos': {
          const { path } = await request.json() as { path?: string }
          if (!path)
            throw new Error('A path is required.')
          const info = await open(path)
          if (!info)
            throw new Error(`${path} is not a git repository.`)
          await store.add(info)
          return json({ repo: info })
        }

        case 'GET status': {
          const repo = repoFrom(url)
          return json(await status(repo))
        }

        case 'GET overview': {
          // One request for everything the chrome needs, because four separate
          // round trips would each re-resolve the repo and the toolbar would
          // paint in four steps.
          const repo = repoFrom(url)
          const [state, branchList, treeList, remoteList, fetched] = await Promise.all([
            status(repo),
            branches(repo),
            worktrees(repo),
            remotes(repo),
            lastFetch(repo),
          ])
          return json({
            repo,
            status: state,
            branches: branchList,
            worktrees: treeList,
            remotes: remoteList,
            lastFetch: fetched?.toISOString() ?? null,
          })
        }

        case 'GET log': {
          const repo = repoFrom(url)
          return json({
            commits: await log(repo, {
              limit: Number.parseInt(url.searchParams.get('limit') ?? '100', 10),
              skip: Number.parseInt(url.searchParams.get('skip') ?? '0', 10),
            }),
          })
        }

        case 'GET commit': {
          const repo = repoFrom(url)
          const hash = url.searchParams.get('hash')
          if (!hash)
            throw new Error('A commit hash is required.')
          const [files, patch] = await Promise.all([
            commitFiles(repo, hash),
            diff(repo, { commit: hash, path: url.searchParams.get('path') ?? undefined }),
          ])
          return json({ files, diff: patch })
        }

        case 'GET diff': {
          const repo = repoFrom(url)
          const path = url.searchParams.get('path') ?? undefined
          const staged = url.searchParams.get('staged') === 'true'

          // An untracked file has no index entry, so a plain `git diff` says
          // nothing about it. The UI still needs to show its contents as an
          // all-additions patch, which is what the untracked path produces.
          if (path && url.searchParams.get('untracked') === 'true')
            return json({ diff: await diffUntracked(repo, path) })

          return json({ diff: await diff(repo, { path, staged }) })
        }

        case 'POST stage': {
          const repo = repoFrom(url)
          const { paths } = await request.json() as { paths?: string[] }
          await setStagedPaths(repo, paths ?? [])
          return json({ status: await status(repo) })
        }

        case 'POST commit': {
          const repo = repoFrom(url)
          const body = await request.json() as { summary?: string, description?: string, amend?: boolean }

          // The set of paths comes from the session, never from the request.
          // The checkboxes the user sees are rendered from that same state, so
          // taking a list off the wire would let a stale page commit a
          // selection the current view never showed.
          const state = await status(repo)
          const paths = session.stagedPaths(state.files.map(file => file.path))
          if (paths.length === 0)
            throw new Error('No files are selected for this commit.')

          // Staging and committing are one operation from the UI's point of
          // view: the checkbox state IS what gets committed. Splitting them
          // would let a refresh land between the two and commit a set the user
          // never confirmed.
          await setStagedPaths(repo, paths)
          const result = await commit(repo, {
            summary: body.summary ?? '',
            description: body.description,
            amend: body.amend,
          })
          return json({ commit: result, status: await status(repo) })
        }

        case 'POST discard': {
          const repo = repoFrom(url)
          const { path } = await request.json() as { path?: string }
          if (!path)
            throw new Error('A path is required.')
          await discard(repo, path)
          return json({ status: await status(repo) })
        }

        case 'POST fetch': {
          const repo = repoFrom(url)
          const { remote } = await request.json().catch(() => ({})) as { remote?: string }
          const result = await gitFetch(repo, remote ?? 'origin')
          return json({ output: result.output, status: await status(repo) })
        }

        case 'POST checkout': {
          const repo = repoFrom(url)
          const { branch } = await request.json() as { branch?: string }
          if (!branch)
            throw new Error('A branch is required.')
          await checkout(repo, branch)
          return json({ status: await status(repo) })
        }

        default:
          return json({ error: `No API route for ${request.method} /api/${route}` }, 404)
      }
    }
    catch (error) {
      return failure(error)
    }
  }
}
