# ReviewOS Desktop

A native desktop client for reviewing, staging and committing work, built with
[stx](https://github.com/stacksjs/stx) and [craft](https://github.com/home-lang/craft).

It is laid out like GitHub Desktop — a chrome of four segmented controls over a
list pane and a diff pane — with one difference: the left rail is stx's Arc
sidebar, and each open repository is a *space*. Spaces carry their own colour,
so switching repositories is a swipe and the panel tells you where you are
before you have read anything.

Not Electron. The window is a real WebKit view driven by Craft's Zig binary.

## Running it

```bash
pantry install && bun install && bun run start
```

`bun run start` opens the repository in the current directory. To open another:

```bash
bun run start --repo ~/Code/some-project
```

Other entry points:

| Command | What it does |
| --- | --- |
| `bun run dev` | Same, with the webview inspector and hot reload |
| `bun run serve` | Starts the server with no window, for driving from a browser |
| `bun run test` | Runs the suite |
| `bun run lint` | Lints with [pickier](https://github.com/pickier/pickier) |

## How it is put together

```
src/
  git/       git, wrapped — status, log, diff, branches, and the writes
  server/    the local HTTP server, the session, and prop shaping
  views/     the .stx templates the panes are rendered from
  client/    the webview's only script
```

Three ideas carry most of the design.

**Only the server renders.** The panes are `.stx` components, and every
interaction re-renders them on the server and swaps the fragment in. The client
does not build any markup. That is what keeps the tenth interaction identical to
the first paint — there is no second renderer to drift.

**Selection lives on the server.** One window, one process, one session. The
checkbox state the user sees and the set of paths a commit will include are the
same object, so a stale page cannot commit a selection the current view never
showed.

**git is spoken to in argv, never in a shell string.** Every call goes through
one module, with `--porcelain=v2` and NUL-separated output, so a branch called
`--upload-pack=…` or a path with a newline in it is an argument rather than
syntax.

## Requirements

Everything comes from [pantry](https://github.com/pantry-pm/pantry); see
`deps.yaml`.

- **bun** 1.4
- **craft** — the native webview binary, on `PATH`
- **git** 2.47 or newer, for `--pathspec-from-file` and worktree porcelain

## Licence

MIT.
