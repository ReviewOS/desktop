#!/usr/bin/env bun
/**
 * ReviewOS Desktop.
 *
 * Starts the local server, then opens a native window pointed at it. The
 * window is a real WebKit view driven by Craft — not Electron — so the whole
 * app is a few megabytes and opens in well under a second.
 */
import { createWindow } from '@stacksjs/desktop'
import { parseArgs } from 'node:util'
import { startServer } from './server'

const { values } = parseArgs({
  options: {
    dev: { type: 'boolean', default: false },
    // Run the server without a window, for driving the UI from a browser or
    // from tests.
    headless: { type: 'boolean', default: false },
    port: { type: 'string' },
    // Open a specific repository instead of the one the app was launched from.
    repo: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: true,
})

if (values.help) {
  console.log(`
ReviewOS Desktop

  bun run start              open the repository in the current directory
  bun run start --repo PATH  open a specific repository
  bun run dev                same, with devtools and hot reload
  bun run serve              start the server only, no window

Options:
  --port <n>   bind the local server to a fixed port (default: any free port)
  --headless   do not open a window
  --dev        enable the webview inspector and hot reload
`)
  process.exit(0)
}

async function main(): Promise<void> {
  const server = await startServer({
    port: values.port ? Number.parseInt(values.port, 10) : undefined,
    cwd: values.repo ?? process.cwd(),
  })

  console.log(`ReviewOS Desktop serving on ${server.url}`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.stop()
      process.exit(0)
    })
  }

  // Headless: nothing more to do. Bun keeps the process alive for the
  // listening server, which is what `bun run serve` wants.
  if (values.headless)
    return

  const window = await createWindow(server.url, {
    title: 'ReviewOS',
    width: 1440,
    height: 900,
    // The traffic lights stay, but the bar they sit in does not: the web
    // toolbar renders behind them and the sidebar reaches the top of the
    // window. This is the GitHub Desktop / VS Code arrangement.
    titlebarHidden: true,
    // The sidebar and panes paint their own light/dark surfaces, so the window
    // follows the system rather than being pinned either way.
    darkMode: false,
    resizable: true,
    devTools: values.dev,
    hotReload: values.dev,
  })

  if (!window) {
    console.error(
      'Could not open a native window — the `craft` binary is not on PATH.\n'
      + 'Install it with `pantry install`, or run with --headless '
      + `and open ${server.url} in a browser.`,
    )
    process.exit(1)
  }

  // Closing the window ends the app. Without this the server would keep the
  // process alive with nothing on screen and no way to get it back.
  window.onClosed(() => {
    server.stop()
    process.exit(0)
  })
}

main()
