/**
 * Lint configuration.
 */
export default {
  // `src/views/app.js` is the built client bundle — generated output, not
  // source, and linting it reports on code nobody wrote.
  ignores: ['**/node_modules/**', '**/pantry/**', '**/dist/**'],

  rules: {
    // Off for this project. The canonical order is derived from Tailwind's,
    // and these templates use arbitrary values for nearly every metric —
    // `h-[32px]`, `text-[13px]` — because the layout is matched to AppKit's
    // measurements rather than to a scale. Sorting those into an order nobody
    // reads them in makes diffs noisier without making markup clearer.
    'pickier/sort-tailwind-classes': 'off',

    // `src/main.ts` is the app's entry point: it starts a server and opens a
    // window, both of which are async, and there is nothing after it to
    // return to. Wrapping the whole file in a `main()` to satisfy the rule
    // would indent every line to hide the one thing the file exists to do.
    'ts/no-top-level-await': 'off',
  },
}
