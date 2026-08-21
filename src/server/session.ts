/**
 * What the window is currently looking at.
 *
 * Held in memory on the server rather than in the page, because the server is
 * the thing that renders. One window, one process, one session — this is a
 * desktop app, not a multi-tenant server, and pretending otherwise would mean
 * threading a session id through every request for no one's benefit.
 *
 * Keeping selection here is what lets the panes be rendered in exactly one
 * place. The client asks for a re-rendered fragment instead of re-implementing
 * the list and the diff in JavaScript, so there is no second renderer to drift.
 */
export type Tab = 'changes' | 'history'

export interface Selection {
  /** Root of the repository in view. */
  repo: string | null
  tab: Tab
  /** Path of the changed file selected in the Changes tab. */
  path: string | null
  /** Hash of the commit selected in the History tab. */
  commit: string | null
  /** Paths the user has checked for the next commit. */
  staged: Set<string>
  /** Whether the user has touched the checkboxes since the repo was opened. */
  stagedTouched: boolean
}

export class Session {
  readonly state: Selection = {
    repo: null,
    tab: 'changes',
    path: null,
    commit: null,
    staged: new Set(),
    stagedTouched: false,
  }

  /**
   * Point the window at a repository.
   *
   * Selection is per-repository, so everything downstream of it is cleared —
   * a file path from the previous repo would otherwise be handed to git in
   * the new one, which either errors or, worse, matches a file that happens
   * to share the name.
   */
  openRepo(root: string): void {
    if (this.state.repo === root)
      return
    this.state.repo = root
    this.state.path = null
    this.state.commit = null
    this.state.staged.clear()
    this.state.stagedTouched = false
  }

  setTab(tab: Tab): void {
    this.state.tab = tab
  }

  selectPath(path: string | null): void {
    this.state.path = path
  }

  selectCommit(commit: string | null): void {
    this.state.commit = commit
  }

  toggleStaged(path: string, staged: boolean): void {
    this.state.stagedTouched = true
    if (staged)
      this.state.staged.add(path)
    else
      this.state.staged.delete(path)
  }

  setStaged(paths: string[]): void {
    this.state.stagedTouched = true
    this.state.staged = new Set(paths)
  }

  /**
   * The paths a commit would include.
   *
   * Until the user touches a checkbox, everything is checked — that is what
   * GitHub Desktop does, and it means the common case (commit everything) is
   * zero clicks. Once they have touched one, their selection is authoritative,
   * including the case where they unchecked everything.
   */
  stagedPaths(all: string[]): string[] {
    if (!this.state.stagedTouched)
      return all
    return all.filter(path => this.state.staged.has(path))
  }

  /** Drop selections that no longer exist after the working tree changed. */
  reconcile(paths: string[]): void {
    const live = new Set(paths)

    if (this.state.path && !live.has(this.state.path))
      this.state.path = null

    for (const path of [...this.state.staged]) {
      if (!live.has(path))
        this.state.staged.delete(path)
    }
  }
}
