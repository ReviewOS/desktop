/**
 * Which repositories are open, and where that list is remembered.
 *
 * This doubles as the API's allow-list. Every git call resolves its working
 * directory through `resolve()`, so a request can only ever name a repository
 * the user has explicitly opened — a path in a query string is a *selector*
 * over that set, never a directory the server will run git in on request.
 */
import type { RepoInfo } from '../git/repo'
import { homedir } from 'node:os'
import { dirname, resolve as resolvePath } from 'node:path'
import { open } from '../git/repo'

export interface StoredRepo extends RepoInfo {
  /** ISO timestamp of the last time this repo was selected. */
  opened: string
}

/** Where the list lives between launches. */
function statePath(): string {
  // XDG on Linux, Application Support on macOS — the platform's own answer for
  // "small amount of app state", so it survives an app-bundle replacement.
  const base = process.platform === 'darwin'
    ? `${homedir()}/Library/Application Support/ReviewOS`
    : `${process.env.XDG_STATE_HOME || `${homedir()}/.local/state`}/reviewos`
  return `${base}/repositories.json`
}

export class RepoStore {
  private repos = new Map<string, StoredRepo>()
  private loaded = false

  constructor(private readonly file: string = statePath()) {}

  private async load(): Promise<void> {
    if (this.loaded)
      return
    this.loaded = true

    const handle = Bun.file(this.file)
    if (!(await handle.exists()))
      return

    try {
      const parsed = await handle.json() as StoredRepo[]
      for (const entry of parsed) {
        if (entry?.root)
          this.repos.set(entry.root, entry)
      }
    }
    catch {
      // A corrupt state file must not stop the app from opening. The list is
      // a convenience — it rebuilds the moment the user opens a repo — so it
      // is dropped rather than surfaced as a launch failure.
    }
  }

  private async persist(): Promise<void> {
    await Bun.write(this.file, JSON.stringify([...this.repos.values()], null, 2))
  }

  async list(): Promise<StoredRepo[]> {
    await this.load()
    // Most recently opened first, which is the order the sidebar shows them in.
    return [...this.repos.values()].sort((a, b) => b.opened.localeCompare(a.opened))
  }

  async add(info: RepoInfo): Promise<StoredRepo> {
    await this.load()
    const entry: StoredRepo = { ...info, opened: new Date().toISOString() }
    this.repos.set(info.root, entry)
    await this.persist()
    return entry
  }

  async remove(root: string): Promise<void> {
    await this.load()
    this.repos.delete(root)
    await this.persist()
  }

  /**
   * Map a requested path to an open repository's root, or null.
   *
   * Resolved before comparison so `~/Code/app/.` and a symlinked path both
   * land on the same entry, and compared against known roots rather than
   * probed on disk — an unknown path is refused without touching it.
   */
  resolve(requested: string | null | undefined): string | null {
    if (!requested)
      return this.repos.size === 1 ? [...this.repos.keys()][0] : null

    const wanted = resolvePath(requested)
    if (this.repos.has(wanted))
      return wanted

    // A path *inside* an open repository resolves to that repository, so the
    // UI can pass a file path without first mapping it back to a root.
    for (const root of this.repos.keys()) {
      if (wanted === root || wanted.startsWith(`${root}/`))
        return root
    }

    return null
  }

  /**
   * Seed the list on first launch.
   *
   * An empty app is not useful, and asking the user to find a directory before
   * they have seen anything is a poor first run — so the directory the app was
   * started from is opened when it happens to be a repository.
   */
  async seedFrom(cwd: string): Promise<void> {
    await this.load()
    if (this.repos.size > 0)
      return

    const info = await open(cwd) ?? await open(dirname(cwd))
    if (info)
      await this.add(info)
  }
}
