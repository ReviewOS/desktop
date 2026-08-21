/**
 * Which repository a request acts on.
 *
 * The API takes an optional `repo` parameter and the window has an active
 * repository; getting the precedence between them wrong is silent until the
 * user opens a second repository, at which point every mutation stops.
 */
import { describe, expect, it } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi } from '../src/server/api'
import { Session } from '../src/server/session'
import { RepoStore } from '../src/server/store'

function fixture(): { store: RepoStore, session: Session, api: ReturnType<typeof createApi> } {
  const store = new RepoStore(join(tmpdir(), `reviewos-api-${crypto.randomUUID()}.json`))
  const session = new Session()
  return { store, session, api: createApi(store, session) }
}

/** Any endpoint that resolves a repository; `checkout` fails fast after it. */
async function resolveError(api: ReturnType<typeof createApi>, query = ''): Promise<string | null> {
  const response = await api(new Request(`http://localhost/api/checkout${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }))
  const body = await response.json() as { error?: string }
  return body.error ?? null
}

describe('resolving the repository a request is about', () => {
  it('uses the session when no repo is named, with one repository open', async () => {
    const { store, session, api } = fixture()
    await store.add({ root: '/one', name: 'one', empty: false })
    session.openRepo('/one')

    // It got past resolution — the failure is the missing branch argument.
    expect(await resolveError(api)).toMatch(/branch is required/i)
  })

  it('still uses the session once a second repository is open', async () => {
    // The regression. Resolution used to go through the store, whose
    // no-argument form only answers when exactly one repository has ever been
    // added — so opening a second one broke commit, fetch, checkout and
    // discard with "No repository is open" while a repository was plainly
    // selected and its files were on screen.
    const { store, session, api } = fixture()
    await store.add({ root: '/one', name: 'one', empty: false })
    await store.add({ root: '/two', name: 'two', empty: false })
    session.openRepo('/two')

    expect(await resolveError(api)).toMatch(/branch is required/i)
  })

  it('says so when nothing is open at all', async () => {
    const { api } = fixture()
    expect(await resolveError(api)).toMatch(/no repository is open/i)
  })

  it('refuses a repo parameter naming a directory that was never opened', async () => {
    // The parameter is a selector over what the user opened, never a
    // directory the server will run git in on request.
    const { store, session, api } = fixture()
    await store.add({ root: '/one', name: 'one', empty: false })
    session.openRepo('/one')

    expect(await resolveError(api, '?repo=/etc')).toMatch(/not an open repository/i)
  })

  it('honours an explicit repo parameter over the session', async () => {
    const { store, session, api } = fixture()
    await store.add({ root: '/one', name: 'one', empty: false })
    await store.add({ root: '/two', name: 'two', empty: false })
    session.openRepo('/one')

    expect(await resolveError(api, '?repo=/two')).toMatch(/branch is required/i)
  })
})

describe('unknown routes', () => {
  it('reports the method and path rather than a bare 404', async () => {
    const { api } = fixture()
    const response = await api(new Request('http://localhost/api/nope'))
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toContain('/api/nope')
  })
})
