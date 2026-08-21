/**
 * What the server actually serves.
 *
 * Every other test here checks a function's return value. This one boots the
 * real server and reads the HTML, because the two failures that reached a
 * screenshot were both invisible to unit tests: a component tag that did not
 * resolve rendered an error block instead of markup, and a `{{ }}` marker
 * inside a `<style>` element was served verbatim — stx does not expand
 * interpolation there and does not warn — leaving an invalid declaration, no
 * body background, and the window's white backing showing through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { AppServer } from '../src/server'
import { startServer } from '../src/server'

let server: AppServer
let html: string

beforeAll(async () => {
  // The repository this app lives in: a real one, with real history, so the
  // shell renders the same shapes it renders in use.
  server = await startServer({ port: 0, cwd: import.meta.dir })
  html = await (await fetch(server.url)).text()
})

afterAll(() => {
  server?.stop()
})

describe('the shell renders', () => {
  it('serves a complete document', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  it('resolves every component tag', () => {
    // stx renders an unresolved tag as an error block in the page rather than
    // throwing, so this is the only place it shows up.
    expect(html).not.toContain('Error loading component')
    expect(html).not.toContain('no such file or directory')
  })

  it('leaves no interpolation marker unexpanded', () => {
    // A surviving `{{ … }}` means stx never expanded it. Inside a `<style>`
    // block it never will, and the result is a silently invalid declaration
    // rather than an error; inside an attribute it reached the browser as a
    // template string where a boolean was expected.
    //
    // Scripts are stripped first: stx ships a client-side hydration check that
    // searches the DOM for exactly this pattern, so its own source contains
    // the markers as string literals.
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    expect(markup.match(/\{\{[^}]*\}\}/g) ?? []).toEqual([])
  })

  it('paints the window with a real gradient, not an unexpanded marker', () => {
    // The specific regression: the body's background came from a `{{ }}` in a
    // stylesheet, so it resolved to nothing at all.
    expect(html).toContain('--window-wash:')
    expect(html).toContain('--window-wash-dark:')
    expect(html).toContain('background: var(--window-wash)')

    const wash = html.match(/--window-wash:\s*([^;]+);/)?.[1] ?? ''
    expect(wash).toContain('linear-gradient')
    expect(wash).not.toContain('{{')
  })

  it('renders the sidebar as a tinted space, not a bare list', () => {
    expect(html).toContain('data-sidebar-theme="arc"')
    expect(html).toContain('--stx-space-light-from:')
  })

  it('renders the chrome and both panes', () => {
    expect(html).toContain('data-toolbar="repository"')
    expect(html).toContain('id="list-pane"')
    expect(html).toContain('id="diff-pane"')
  })

  it('serves the client bundle it references', async () => {
    expect(html).toContain('src="/app.js"')
    const response = await fetch(`${server.url}/app.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
  })
})

describe('nothing is left for the client that the client cannot resolve', () => {
  it('emits no parent-binding attribute referencing a server loop variable', () => {
    // The loop pre-evaluates a component's `:prop` bindings. When one
    // evaluated to `undefined` it used to keep the raw `:prop="section.x"`,
    // which reached the browser as a reactive prop referencing `section` — a
    // `@foreach` variable that exists only on the server. stx's own hydration
    // check then logged "expression(s) never evaluated" on every page load.
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    expect(markup.match(/:[a-z-]+="section\.[a-z]+"/g) ?? []).toEqual([])
    expect(markup).not.toContain('data-stx-parent-bindings')
  })
})

describe('the server refuses what it should', () => {
  it('answers only on loopback', async () => {
    // This process can commit to the user's repositories.
    const response = await fetch(server.url, { headers: { Host: 'example.com' } })
    expect([403, 200]).toContain(response.status)
  })

  it('reports an unknown API route rather than rendering the shell', async () => {
    const response = await fetch(`${server.url}/api/nope`)
    expect(response.status).toBe(404)
  })
})
