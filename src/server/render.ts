/**
 * Rendering one component to an HTML fragment.
 *
 * The panes are re-rendered on every interaction, and they have to come out
 * identical to the first paint. The only way to guarantee that is to run the
 * same `.stx` file through the same pipeline — so this builds a one-tag
 * template and hands it to `processDirectives` with the props as its context,
 * exactly as the full page does when it reaches `<ListPane …>`.
 */
import type { StxOptions } from '@stacksjs/stx'
import { loadStxConfig, processDirectives } from '@stacksjs/stx'
import { dirname, join } from 'node:path'

const PROJECT_ROOT = dirname(dirname(import.meta.dir))
// Component resolution is relative to the file being rendered, so fragments
// are attributed to the shell — the same base the full page resolves from.
const RENDER_FROM = join(PROJECT_ROOT, 'src', 'views', 'index.stx')

let options: StxOptions | null = null

async function stxOptions(): Promise<StxOptions> {
  options ??= await loadStxConfig(PROJECT_ROOT)
  return options
}

export async function renderComponent(
  component: string,
  props: Record<string, unknown>,
): Promise<string> {
  const names = Object.keys(props)

  // Bound with `:` so each value arrives as the object it is, rather than as
  // its `String()` form — an items array has to stay an array.
  const attributes = names.map(name => `:${name}="${name}"`).join(' ')
  const template = `<${component} ${attributes} />`

  return processDirectives(
    template,
    { ...props, __filename: RENDER_FROM, __dirname: dirname(RENDER_FROM) },
    RENDER_FROM,
    await stxOptions(),
    new Set<string>(),
  )
}
