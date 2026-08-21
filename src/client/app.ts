/**
 * The webview side.
 *
 * Deliberately small. It does not render anything — it moves the selection on
 * the server and swaps in the HTML the server sends back. That is what keeps
 * the panes identical between the first paint and every interaction after it:
 * there is only ever one renderer, and it is not this file.
 */

interface PaneUpdate {
  list: string
  diff: string
  title: string
}

interface SelectBody {
  repo?: string
  tab?: 'changes' | 'history'
  path?: string | null
  commit?: string | null
  check?: { path: string, checked: boolean }
}

const listPane = () => document.querySelector<HTMLElement>('#list-pane')
const diffPane = () => document.querySelector<HTMLElement>('#diff-pane')

/**
 * Swap a fragment in, lifting its stylesheet into the head.
 *
 * Each fragment carries the CSS for the classes it uses, generated from that
 * render. Left inline, a pane swapped fifty times would leave fifty stylesheets
 * in the document; hoisted into one keyed element per pane, it stays at two.
 */
function swap(host: HTMLElement | null, fragment: string, key: string): void {
  if (!host)
    return

  const parsed = new DOMParser().parseFromString(fragment, 'text/html')
  const style = parsed.querySelector('style[data-crosswind]')

  if (style) {
    style.remove()
    const id = `pane-css-${key}`
    const existing = document.getElementById(id)
    const next = document.createElement('style')
    next.id = id
    next.textContent = style.textContent
    if (existing)
      existing.replaceWith(next)
    else
      document.head.append(next)
  }

  host.replaceChildren(...Array.from(parsed.body.childNodes))
}

async function select(body: SelectBody): Promise<void> {
  const response = await fetch('/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    reportError(await readError(response))
    return
  }

  const update = await response.json() as PaneUpdate
  swap(listPane(), update.list, 'list')
  swap(diffPane(), update.diff, 'diff')
  document.title = update.title
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string }
    return body.error ?? `Request failed (${response.status})`
  }
  catch {
    return `Request failed (${response.status})`
  }
}

/** Show a failure where the user is looking, not in a console they cannot see. */
function reportError(message: string): void {
  const slot = document.querySelector<HTMLElement>('[data-commit-error]')
  if (slot) {
    slot.textContent = message
    slot.classList.remove('hidden')
    return
  }
  // No commit box on screen (History tab, or no repo) — fall back to the diff
  // pane, which is the largest surface and always present.
  const pane = diffPane()
  if (pane)
    pane.innerHTML = `<p class="px-4 py-6 text-center text-[13px] text-[#ff383c]"></p>`
  if (pane?.firstElementChild)
    pane.firstElementChild.textContent = message
}

/**
 * Everything is one delegated listener on the document.
 *
 * The panes are replaced wholesale on every interaction, so a listener bound
 * to a row would be discarded with it. Delegation means the wiring survives
 * the swap, which is the whole reason the server can own rendering.
 */
function wire(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const tab = target.closest<HTMLElement>('[data-tab]')
    if (tab) {
      void select({ tab: tab.dataset.tab as 'changes' | 'history' })
      return
    }

    // A checkbox click also lands on the row; handled by `change` instead, so
    // bail out here or the row selection would fight the checkbox.
    if (target.closest('[data-check]'))
      return

    const row = target.closest<HTMLElement>('[data-row]')
    if (row) {
      const id = row.dataset.row!
      const isCommit = /^[0-9a-f]{40}$/.test(id)
      void select(isCommit ? { commit: id } : { path: id })
      return
    }

    // Sidebar rows. Their ids are namespaced by what they select, so one
    // listener covers the tabs and the branch list without the sidebar
    // needing to know anything about the app.
    const item = target.closest<HTMLElement>('[data-item-id]')
    if (item) {
      const id = item.dataset.itemId ?? ''
      if (id.startsWith('tab:')) {
        void select({ tab: id.slice(4) as 'changes' | 'history' })
        return
      }
      if (id.startsWith('branch:')) {
        void run('/api/checkout', { branch: id.slice(7) })
        return
      }
    }

    // A space IS a repository — switching spaces switches repositories. The
    // sidebar swipes between them on its own; this keeps the server's idea of
    // which one is open in step with what the panel is showing.
    const space = target.closest<HTMLElement>('[data-space-id]')
    if (space) {
      // A full reload rather than a pane swap. Switching repository changes
      // the sidebar's own sections, the toolbar and both panes at once, and
      // re-rendering the sidebar under the carousel would fight the swipe
      // state it is holding.
      void select({ repo: space.dataset.spaceId }).then(() => location.reload())
      return
    }

    const toolbar = target.closest<HTMLElement>('[data-toolbar]')
    if (toolbar?.dataset.toolbar === 'fetch')
      void run('/api/fetch', {})
  })

  document.addEventListener('change', (event) => {
    const check = (event.target as HTMLElement).closest<HTMLInputElement>('[data-check]')
    if (!check)
      return
    void select({ check: { path: check.dataset.check!, checked: check.checked } })
  })

  document.addEventListener('submit', (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-commit-form]')
    if (!form)
      return
    event.preventDefault()

    const data = new FormData(form)
    void run('/api/commit', {
      summary: String(data.get('summary') ?? ''),
      description: String(data.get('description') ?? ''),
      // The server holds the checked set, so it is not sent — sending it would
      // make the page's idea of the selection authoritative over the server's,
      // and the two would disagree the first time a render was skipped.
      paths: undefined,
    })
  })

  // ⌘R re-reads the working tree. A desktop app has no address bar to reload
  // from, and git state changes underneath it constantly.
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'r') {
      event.preventDefault()
      void select({})
    }
  })
}

/** A mutation, followed by a re-render of both panes. */
async function run(endpoint: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    reportError(await readError(response))
    return
  }

  await select({})
}

wire()
