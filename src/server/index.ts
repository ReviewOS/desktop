/**
 * The app's HTTP server.
 *
 * Three kinds of route, and the split is deliberate:
 *
 *   /api/*    JSON. Mutations, and anything the client needs as data.
 *   /pane/*   HTML fragments, rendered by the same components as the full
 *             page. The client swaps them in rather than re-implementing the
 *             list and the diff in JavaScript — one renderer, so nothing can
 *             drift between the first paint and the tenth interaction.
 *   /         the full shell.
 *
 * Bound to loopback. This process can read any repository the user has opened
 * and can commit to it, so it must not be reachable from the network.
 */
import type { Server } from 'bun'
import { serve as stxServe } from '@stacksjs/stx'
import { dirname, join } from 'node:path'
import { diff, diffUntracked } from '../git/diff'
import { commitFiles, log } from '../git/log'
import { branches, lastFetch, remotes, worktrees } from '../git/repo'
import { status } from '../git/status'
import { commit, discard, fetch as gitFetch, setStagedPaths } from '../git/write'
import { createApi } from './api'
import { buildShell } from './shell'
import { Session } from './session'
import { RepoStore } from './store'

const VIEWS = join(dirname(dirname(import.meta.dir)), 'src', 'views')

export interface AppServer {
  url: string
  port: number
  stop: () => void
  server: Server<undefined>
}

/** Everything the shell and the panes are rendered from, gathered once. */
async function gather(session: Session, store: RepoStore) {
  const repos = await store.list()
  const repo = session.state.repo

  if (!repo) {
    return {
      session,
      repos,
      status: { branch: '', ahead: 0, behind: 0, detached: false, files: [] },
      branches: [],
      worktrees: [],
      remotes: [],
      lastFetch: null,
      commits: [],
      diffFiles: [],
    }
  }

  // Everything at once: these are independent git invocations and running them
  // in sequence would make the pane visibly assemble itself.
  const [state, branchList, treeList, remoteList, fetched, commits] = await Promise.all([
    status(repo),
    branches(repo),
    worktrees(repo),
    remotes(repo),
    lastFetch(repo),
    session.state.tab === 'history' ? log(repo, { limit: 200 }) : Promise.resolve([]),
  ])

  return {
    session,
    repos,
    status: state,
    branches: branchList,
    worktrees: treeList,
    remotes: remoteList,
    lastFetch: fetched,
    commits,
    diffFiles: await selectedDiff(session, state),
  }
}

/** The patch for whatever is selected, or nothing when nothing is. */
async function selectedDiff(session: Session, state: Awaited<ReturnType<typeof status>>) {
  const repo = session.state.repo
  if (!repo)
    return []

  if (session.state.tab === 'history') {
    return session.state.commit
      ? diff(repo, { commit: session.state.commit })
      : []
  }

  const path = session.state.path
  if (!path)
    return []

  // An untracked file has no index entry, so `git diff` says nothing about it.
  const file = state.files.find(entry => entry.path === path)
  if (file?.unstaged === 'untracked')
    return diffUntracked(repo, path)

  // Staged content and worktree content are different patches. Showing the
  // worktree diff for a fully-staged file renders an empty pane and looks
  // like a bug, so fall back to the staged view when the worktree is clean.
  const worktree = await diff(repo, { path })
  if (worktree.length > 0)
    return worktree
  return diff(repo, { path, staged: true })
}

export async function startServer(options: { port?: number, cwd?: string } = {}): Promise<AppServer> {
  const store = new RepoStore()
  await store.seedFrom(options.cwd ?? process.cwd())

  const session = new Session()
  const [first] = await store.list()
  if (first)
    session.openRepo(first.root)

  const api = createApi(store, session)

  /** Props for a render, computed fresh so a pane never shows stale state. */
  const props = async () => buildShell(await gather(session, store))

  const result = await stxServe({
    port: options.port ?? 0,
    root: VIEWS,
    // The project root, where stx.config.ts registers the component library.
    // `root` above is the views directory, which is two levels below it.
    configDir: dirname(dirname(import.meta.dir)),
    watch: false,

    onRequest: async (request) => {
      const url = new URL(request.url)

      // Loopback only. Bun binds 0.0.0.0 by default, and this server can
      // commit to the user's repositories.
      const host = url.hostname
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1')
        return new Response('Forbidden', { status: 403 })

      if (url.pathname.startsWith('/api/'))
        return api(request)

      if (url.pathname === '/select' && request.method === 'POST')
        return select(request)

      if (url.pathname.startsWith('/pane/'))
        return pane(url)

      if (url.pathname === '/app.js')
        return script()

      return null
    },
  })

  /**
   * Move the selection, then hand back the panes it changed.
   *
   * One round trip rather than "mutate, then fetch each pane": a click on a
   * file should not be able to leave the list highlighted and the diff showing
   * the previous file because the second request failed.
   */
  async function select(request: Request): Promise<Response> {
    const body = await request.json() as {
      repo?: string
      tab?: 'changes' | 'history'
      path?: string | null
      commit?: string | null
      check?: { path: string, checked: boolean }
      staged?: string[]
    }

    if (body.repo) {
      const resolved = store.resolve(body.repo)
      if (!resolved)
        return Response.json({ error: `${body.repo} is not an open repository.` }, { status: 400 })
      session.openRepo(resolved)
    }
    if (body.tab)
      session.setTab(body.tab)
    if (body.path !== undefined)
      session.selectPath(body.path)
    if (body.commit !== undefined)
      session.selectCommit(body.commit)
    if (body.check)
      session.toggleStaged(body.check.path, body.check.checked)
    if (body.staged)
      session.setStaged(body.staged)

    return renderPanes()
  }

  async function renderPanes(): Promise<Response> {
    const shell = await props()
    const [list, diffHtml] = await Promise.all([
      renderPane('ListPane', { tab: shell.tab, items: shell.listItems, summary: shell.summary, hasRepo: shell.hasRepo }),
      renderPane('DiffPane', { files: shell.diffFiles }),
    ])
    return Response.json({ list, diff: diffHtml, title: shell.title, toolbar: shell.toolbar })
  }

  async function pane(url: URL): Promise<Response> {
    const name = url.pathname.slice('/pane/'.length)
    const shell = await props()

    if (name === 'list') {
      return html(await renderPane('ListPane', {
        tab: shell.tab, items: shell.listItems, summary: shell.summary, hasRepo: shell.hasRepo,
      }))
    }
    if (name === 'diff')
      return html(await renderPane('DiffPane', { files: shell.diffFiles }))

    return new Response('Not found', { status: 404 })
  }

  // Exposed so the shell template can render from the same props the panes
  // do. A `<script server>` block has no access to the server's own state, and
  // there is exactly one session for exactly one window, so a global is
  // honest here rather than a shortcut around a missing parameter.
  const shared = globalThis as Record<string, unknown>
  shared.__reviewosProps = props

  // `Server.port` is optional in Bun's types because a server can be bound to
  // a unix socket instead. This one was just started on a TCP port, so the
  // narrowing is a statement of what already happened, not an assumption.
  const port = result.server.port
  if (port === undefined)
    throw new Error('The app server started without a TCP port.')

  return {
    url: `http://localhost:${port}`,
    port,
    stop: result.stop,
    server: result.server as Server<undefined>,
  }
}

/**
 * The webview's bundle, served from `dist/` rather than from the template
 * root — see `scripts/build-client.ts` for why it is built there.
 */
async function script(): Promise<Response> {
  const file = Bun.file(join(dirname(dirname(import.meta.dir)), 'dist', 'app.js'))
  if (!(await file.exists())) {
    return new Response('The client bundle is missing. Run `bun scripts/build-client.ts`.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return new Response(file, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
}

function html(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

/**
 * Render one component to a fragment.
 *
 * Deliberately goes through the same `.stx` file the full page uses, rather
 * than a string template that "just renders the list" — the moment those are
 * two files they start to disagree, and the disagreement shows up as the pane
 * changing appearance after the first click.
 */
async function renderPane(component: string, componentProps: Record<string, unknown>): Promise<string> {
  const { renderComponent } = await import('./render')
  return renderComponent(component, componentProps)
}

export { RepoStore, Session, buildShell, commit, commitFiles, discard, gitFetch, setStagedPaths }
