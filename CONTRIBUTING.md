# Contributing to mvpfy

Thanks for helping build the IDE for PMs!

## Getting started

```bash
npm install
npm run dev        # Vite dev server + Electron
```

## Checks

Run everything CI runs before opening a PR:

```bash
npm run lint       # eslint + prettier
npm test           # vitest unit tests
npm run build      # typecheck + bundle main/preload/renderer
```

## Architecture

See the Architecture section in the README. In short: the Electron **main process** is split
into single-purpose service modules under `electron/services/` behind an IPC controller
(`electron/ipc.ts`); the **renderer** keeps behavior in controller hooks (`src/hooks/`) and
domain logic in `src/lib/`, with presentational components under `src/components/`.

Guidelines:

- Pure logic goes in `src/lib/` or `shared/` with a unit test next to it.
- Components stay presentational — no `window.mvpfy` calls inside components; go through a
  controller hook.
- Anything that touches the filesystem, shells out, or talks to the network belongs in a
  main-process service, exposed via a typed method on `MvpfyApi` (`shared/types.ts`).
- Every spawned command must stay inside `~/.mvpfy/projects` (see `isManagedPath`).

## A note on how this repo is built

mvpfy is built the way mvpfy works: a product owner directing coding agents (mostly Claude
Code). PRs from humans and agents are both welcome — the bar is the same: green CI and a
readable diff.
