# mvpfy UI — build conventions

React components from the mvpfy desktop app (the IDE for PMs). No provider or wrapper is
required — every component is self-contained. System font stack; no custom fonts to load.

## Styling idiom: purged Tailwind utility classes

Styling is Tailwind, but the shipped `styles.css` is a **compiled, purged build**: only the
utility classes listed below (and the others visible in `_ds_bundle.css`) exist. A Tailwind
class not present in that stylesheet silently does nothing — before styling your own layout
glue, check the class exists in `_ds_bundle.css`.

Core vocabulary (all verified present):

| Purpose | Classes |
|---|---|
| Brand purple | `bg-brand` (buttons), `bg-brand-dark` (sidebar/primary), `hover:bg-brand-hover`, `text-brand` (links) |
| Neutral surfaces | `bg-white`, `bg-slate-50`, `bg-slate-100`, `border-slate-200`, `text-slate-500` |
| Success / running | `bg-emerald-600`, `bg-emerald-50`, `text-emerald-700` |
| Attention | `bg-amber-50`, `border-amber-300`, `text-amber-700` |
| Danger | `bg-red-600`, `bg-red-50`, `text-red-600` |
| Shape & type | `rounded-md`, `rounded-lg`, `font-mono` (URLs, code, credentials), `text-xs`/`text-sm` |

Section headers use `text-sm font-semibold uppercase tracking-wide text-slate-500`; cards
are `rounded-lg border border-slate-200 bg-white p-4`.

## The controller-prop pattern

The `project/*` cards (`EnvironmentCard`, `StoriesCard`, `ProjectHeader`, `QuestionsCard`,
`GeneratedFilesCard`) take a single prop `c` — a plain object carrying the fields named in
each component's `.d.ts`. Pass data + no-op handlers; there is no context to wire:

```jsx
<StoriesCard c={{
  project: { localPath: '/ws/billing', basePort: 4101, status: 'running',
             repos: [{ url: 'https://github.com/acme/billing', dir: '/ws/billing' }] },
  stories: [{ id: 's1', code: 'ACME-12', title: 'Export aging report', status: 'ready' }],
  targetRepoDir: '/ws/billing', storiesError: null, loadingStories: false,
  tenantConnected: true, busy: false, lastShipPrUrl: null,
  implement: async () => {}, refreshStories: async () => {},
  setTargetRepoDir: () => {}, openExternal: () => {},
}} />
```

`LogPanel`, `ProjectList`, `Settings`, `DemoCredentialsCard`, `MobilePreviewCard` take
conventional named props — see each `.d.ts`.

## Where the truth lives

Read `styles.css` → `_ds_bundle.css` for the full class inventory, and each component's
`.prompt.md` for working example compositions (they are the verified previews).
