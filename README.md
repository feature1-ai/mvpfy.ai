# mvpfy by [feature1](https://feature1.ai)

**The IDE for PMs.** Describe any change to your product in plain language — see it running
locally, then ship it as a pull request. Like Lovable or Replit, but on your **existing
codebase**, on your **own machine**, with your team's PR review as the exit. Live preview of
the running app and a full VS Code editor built in; [Feature1](https://feature1.ai) user
stories become PRs with one click.

mvpfy is a minimal Electron desktop app for non-technical product managers. It is a **thin
wrapper over [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and
[Codex CLI](https://github.com/openai/codex)** — it does not reimplement any agent logic. It
handles setup checks, workspace management, curated prompts, and invoking the external CLI;
the agents do the actual engineering work.

> **Bring your own agent.** mvpfy shells out to `claude` and `codex`. You must have your own
> API keys / subscriptions for those tools, installed and authenticated on your machine.

## How is this different from Cursor / Windsurf / Antigravity?

Those are **code-first** tools: they open on a codebase and make engineers faster, one
reviewed diff at a time. mvpfy is **product-first**:

- The unit of work is a **change to the product** — a plain-language request or a user
  story, never a file. The loop is describe → running app → pull request; the PM never
  reads a diff — the PR is the engineers' review artifact.
- AI IDEs assume a working dev environment. mvpfy **manufactures one**: it dockerizes the
  repo, finds a free port, fills in missing services with open-source stand-ins, and hands
  the PM a URL and demo login so they can *see* the product.
- The system of record is the **backlog**: acceptance criteria get tracked, the PR gets
  attached, and the story moves to ready-for-testing in Feature1 automatically.
- mvpfy doesn't compete on the agent or the editor — it orchestrates the same engines
  (Claude Code, Codex) and embeds VS Code for when someone technical leans in.

In short: Cursor makes engineers faster; mvpfy makes PMs shippers.

## And how is it different from Lovable / Replit?

Same magic loop — describe, see it live, ship — but pointed at a different problem. Those
tools excel at building **new** apps in **their** cloud. mvpfy runs that loop on the product
your company **already has**: your real repos, cloned locally, running in Docker on your
machine (nothing leaves it), with changes exiting through a branch and a pull request your
engineers review — not a deploy button. It's Lovable for the other 95% of software work:
the product that already exists.

## Requirements

The app checks for these CLIs on first launch (Settings → Required CLIs):

| Tool | Install |
| --- | --- |
| `git` | `xcode-select --install` |
| `gh` | `brew install gh` (then `gh auth login`) |
| `docker` | `brew install --cask docker` |
| `claude` | `npm install -g @anthropic-ai/claude-code` |
| `codex` | `npm install -g @openai/codex` |

## Setup

```bash
npm install
```

## Run in development

```bash
npm run dev
```

Starts the Vite dev server and launches Electron against it.

## Build & package

```bash
npm run build      # typecheck + build renderer and main/preload
npm run package    # package the macOS app into release/
```

## How it works

1. **Connect Feature1** — Settings → enter your tenant slug → Sign in. A browser window opens
   for OAuth; the MCP session token is stored encrypted via the OS keychain (`safeStorage`).
   The MCP endpoint is `https://<tenant>-mcp.feature1.ai/mcp/`.
2. **Add project** — paste one or more GitHub/GitLab repo URLs (one per line for multi-repo
   stacks), or add a **local repository** by path / the Browse… button. Everything is cloned
   into `~/.mvpfy/projects/<slug>`; local repos keep their original `origin` remote so the
   PR flow still targets the real remote.
3. **Bootstrap environment** — the goal of this step is that you can *see the app running
   locally*. mvpfy finds a free port and asks your default agent to make the repo fully
   runnable: it generates `mvpfy.yml`, a `Dockerfile` (if missing),
   `docker-compose.mvpfy.yml`, and `.env.mvpfy.example`, and fills any gaps with open-source
   stand-ins — official images for missing infrastructure (postgres, redis, minio, mailhog,
   …) and generated mock services under `mvpfy/` in the repo when a backend or third-party
   API isn't available. If the agent is genuinely blocked (e.g. it needs the real backend
   repo URL), it writes its questions to `mvpfy-questions.md`; the app shows them, you type
   answers, and bootstrap re-runs with your answers.
   **Nothing runs automatically**: you review the generated files in the app, then explicitly
   click *Start environment*, which runs `docker compose -f docker-compose.mvpfy.yml up -d`.
   The app then polls the port and shows a green "App is up" link once the app actually
   responds.
4. **Ask mvpfy to change something** — a plain-language box on the project Overview:
   "Add an environment variable STRIPE_API_KEY=… to the backend", "move the app to port
   5000". The agent applies the smallest safe change (secrets go into the local env file,
   never into code), reports back in plain language, and offers a one-click restart when
   the environment needs it.
5. **Implement a story** — refresh the story list (loaded from the Feature1 MCP server), click
   *Implement*. mvpfy invokes the agent with the ship-feature prompt: it loads the workflow,
   implements every acceptance criterion, runs the tests, commits, pushes, opens a PR with
   `gh`, and updates the Feature1 workflow via MCP. Output streams live into the log panel,
   and the PR URL is captured and shown when the run succeeds.

## Architecture

MVC-style separation across Electron's two processes:

```
electron/                     — MAIN PROCESS
  main.ts                     — bootstrap: window lifecycle, service wiring
  ipc.ts                      — controller: routes typed IPC calls to services
  paths.ts                    — managed-directory layout + path guards
  services/
    shell.ts                  — platform shell layer (zsh/bash/cmd), PATH resolution
    store.ts                  — persistent state model (~/.mvpfy/state.json)
    secrets.ts                — safeStorage-encrypted token store
    cli.ts                    — CLI presence + sign-in detection
    runs.ts                   — streaming command runner (event sink injected)
    docker.ts                 — local-context pinning, daemon checks, command builders
    agents.ts                 — Claude Code / Codex invocation
    projects.ts               — workspace create/clone/read/write/delete
    net.ts                    — free ports, health probes, MCP fetch proxy
shared/                       — types + pure helpers used by both processes
src/                          — RENDERER
  lib/                        — model/domain logic (MCP client, prompts, parsers) + tests
  hooks/                      — controllers (useProjectController, useRuns)
  components/                 — presentational views (project/* cards, PreviewPane, …)
```

Security boundaries: the renderer is sandboxed (contextIsolation, no nodeIntegration) and
reaches the system only through the typed `MvpfyApi` bridge; every spawned command is
confined to `~/.mvpfy/projects`; docker is pinned to the local engine; tokens are encrypted
via the OS keychain; the MCP proxy is https-only and local probes are localhost-only.

**How this repo is built:** mvpfy is built the way mvpfy works — a product owner directing
coding agents (mostly Claude Code). This repo is itself the demo of that workflow.

## Local state

- `~/.mvpfy/state.json` — tenant config, projects, settings.
- `~/.mvpfy/secrets.json` — `safeStorage`-encrypted tokens (never plaintext).
- `~/.mvpfy/projects/<slug>` — cloned repos (agents run sandboxed to these directories).

## Prompt templates

The curated prompts live in `src/prompts/`:

- `bootstrap-runtime.txt` — generate the Docker runtime files for a repo.
- `ship-feature.txt` — the "Ship with AO" flow: implement a Feature1 story end-to-end and
  open a PR. (This automates the manual copy-paste flow from the Feature1 settings panel.)

## Platform support

- **macOS** — primary platform, fully supported (can auto-start Docker Desktop).
- **Linux** — supported; start the Docker daemon yourself.
- **Windows** — experimental beta: commands run through `cmd.exe`; Docker Desktop must be
  running. Feedback welcome.

Beta binaries are unsigned. On macOS, right-click → Open on first launch (or
`xattr -dr com.apple.quarantine "/Applications/mvpfy by feature1.app"`).

## Notes

- First version is intentionally minimal; AO integration is planned for later.
- Default Codex model is `gpt-5.3-codex` (override in Settings).

## License

[MIT](LICENSE)

## Troubleshooting

**macOS says Electron is malware / the binary disappears.** Apple has revoked the code hash
of some older stock Electron dev binaries (malware campaigns bundled the unmodified runtime,
and the revocation hits every identical copy). This project pins Electron ≥ 43, which is not
affected. If you ever hit it again: don't bypass the warning — upgrade `electron` in
`package.json` instead, and verify the download against the official
`SHASUMS256.txt` from the matching GitHub release.

**`spawn …/Electron ENOENT` when starting.** The Electron binary didn't get downloaded by
`npm install` (postinstall was skipped). Run `node node_modules/electron/install.js` once.
