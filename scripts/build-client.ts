#!/usr/bin/env bun
/**
 * Bundle the webview's script.
 *
 * The client is TypeScript and the webview is not, so something has to compile
 * it. Kept as a build step rather than served through a transform so the
 * packaged app ships a plain file with nothing to resolve at launch.
 */
import { dirname, join } from 'node:path'

const root = dirname(import.meta.dir)

async function main(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, 'src', 'client', 'app.ts')],
    // Not into `src/views`: that directory is the template root the server
    // routes over, and a generated bundle sitting in it is both a file the
    // router has to know to skip and a source file the linter has to be told
    // to ignore. Build output belongs outside the sources it was built from.
    outdir: join(root, 'dist'),
    naming: 'app.js',
    target: 'browser',
    minify: process.argv.includes('--minify'),
  })

  if (!result.success) {
    for (const message of result.logs)
      console.error(message)
    process.exit(1)
  }

  console.log(`built ${result.outputs.map(output => output.path).join(', ')}`)
}

main()
