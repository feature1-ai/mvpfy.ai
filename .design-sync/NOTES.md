# design-sync notes — mvpfy

- This repo is an **application**, not a component library. The sync surface is the
  presentational subset only; `App`, `ProjectDetail`, and `PreviewPane` are excluded
  (`componentSrcMap: null`) because they fire Electron IPC (`window.mvpfy`) on mount or use
  the Electron-only `<webview>` tag.
- The library entry is `.design-sync/entry.ts` (committed) — the app has no dist library
  build, so the converter bundles from source via `--entry ./.design-sync/entry.ts`.
- Card components' `ProjectController` imports were changed to `import type` so esbuild
  drops the hooks→agentRunner chain (its `?raw` prompt imports don't bundle otherwise).
  Keep new component imports of controller/lib types as `import type`.
- CSS: `buildCmd` builds the renderer then copies the hashed Tailwind output to a stable
  path (`cp dist/assets/*.css dist/ds-styles.css`). `npm run build` (full) wipes `dist/` —
  always re-run the copy before the converter.
- The shipped stylesheet is a **purged** Tailwind build: only utilities the app uses exist.
  `bg-brand-light` is NOT in it (unused in app); conventions.md enumerates only verified
  classes — re-validate them after UI changes.
- Playwright chromium installed to ~/Library/Caches/ms-playwright (headless shell v1234,
  playwright latest as of 2026-08).

## Re-sync risks

- `dist/ds-styles.css` is generated; if the Tailwind class usage changes (new UI), the
  conventions.md class table may go stale — re-run its validation greps.
- Preview mocks mirror app types (`Project`, `RunState`, `CliStatus`, controller fields).
  A type change in `shared/types.ts` or `useProjectController` can silently break authored
  previews — the capture/grade loop will catch it, but expect regrades after refactors.
- `qrcode` renders the MobilePreviewCard QR at runtime in the card; if that dep is dropped
  the preview goes blank.
