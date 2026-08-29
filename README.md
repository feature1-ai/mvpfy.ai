# mvpfy by [feature1](https://feature1.ai)

**[Website](https://mvpfy.ai/)** · **[Download](https://github.com/feature1-ai/mvpfy.ai/releases/latest)** · MIT

**The IDE for PMs, by [feature1](https://feature1.ai).** Describe any change to your product
in plain language — see it running locally, then ship it as a pull request. Like Lovable or
Replit, but on your **existing codebase**, on your **own machine**, with your team's PR
review as the exit. Live preview of the running app and a full VS Code editor built in. And
you can **plan any feature**: mvpfy writes a minimal PRD in the
[Feature1](https://feature1.ai) style for you to review and agree, then breaks it into user
stories on the feature's own board and executes them one by one — each story lands as a pull
request you test before calling it done. Plan as many features as you like, each with its
own board, even while another feature is still being built.

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
- The system of record is the **plan**: a minimal PRD and user stories on a board
  (To do → Coding → Testing → Done). Each story carries acceptance criteria, exits Coding
  as a pull request, and only a human who has tested it can move it to Done.
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

The app checks for these CLIs on first launch (Settings → Required tools). **On macOS mvpfy
can install them for you** — each missing tool gets an *Install* button that runs the command
below and streams the output. Anything needing your password (Homebrew) or opening Apple's own
installer (`xcode-select`) is handed to Terminal.app instead, because an app shouldn't pretend
it can answer a sudo prompt from a pipe. The command is always shown before it runs.

| Tool | Install | Runs |
| --- | --- | --- |
| `git` | `xcode-select --install` | in Terminal (Apple's installer window) |
| Homebrew | [`install.sh`](https://brew.sh) | in Terminal (asks for your Mac password) |
| `gh` | `brew install gh` (then Sign in) | in mvpfy |
| `docker` | `brew install --cask docker-desktop` | in mvpfy |
| `claude` | `curl -fsSL https://claude.ai/install.sh \| bash` | in mvpfy (no Homebrew or Node) |
| `codex` | `npm install -g @openai/codex` | in mvpfy |

Every command is the tool's own official install line. On Linux and Windows the commands are
shown but not run for you.

**Signing in** is handled the same way. `gh` and `codex` sign in inside mvpfy; Claude Code's
login is interactive, so its button opens Terminal.app running `claude auth login`. Git has no
login of its own — pushes and private clones use the credentials `gh auth login` writes into
git's credential helper, so mvpfy runs `gh auth setup-git` as part of the GitHub sign-in and
the Git row says so while GitHub is not connected.

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

1. **Add project** — paste one or more GitHub/GitLab repo URLs (one per line for multi-repo
   stacks), or add a **local repository** by path / the Browse… button. Everything is cloned
   into `~/.mvpfy/projects/<slug>`; local repos keep their original `origin` remote so the
   PR flow still targets the real remote. A local folder can instead be used **in place**
   (no copy): check *Use this folder in place* and mvpfy works directly in your working
   copy, keeping everything it generates inside a `.mvpfy/` subfolder — removing the
   project later removes only that subfolder and the containers, never your code.
2. **Bootstrap environment** — this starts **automatically** the moment you add the project
   (adding it is the consent); if it can't start — your agent CLI isn't signed in, say — the
   project falls back to a manual *Bootstrap environment* button.
   It runs in two phases. First, in ~30 seconds, the agent reads your repos and writes a
   **task list in plain language** — "your app expects a payments service that isn't in this
   code, so I'll serve realistic fake responses" — which shows on the Overview as cards you
   can follow while the work happens. **Who may close a card matters**: the agent can only
   ever say *working*; mvpfy marks a task **done** when it can see the files that task
   promised, and a claim it can't confirm shows as *unconfirmed* rather than green. The last
   card — your app actually up, with a working demo login — is **yours**: mvpfy moves it to
   *ready to test* and only you mark it done, exactly like a user story.
   The goal of this step is that you can *see the app running
   locally*. mvpfy finds a free port and asks your default agent to make the repo fully
   runnable: it generates `mvpfy.yml`, a `Dockerfile` (if missing),
   `docker-compose.mvpfy.yml`, and `.env.mvpfy.example`, and fills any gaps with open-source
   stand-ins — official images for missing infrastructure (postgres, redis, minio, mailhog,
   …) and generated mock services under `mvpfy/` in the repo when a backend or third-party
   API isn't available. If the agent is genuinely blocked (e.g. it needs the real backend
   repo URL), it writes its questions to `mvpfy-questions.md`; the app shows them, you type
   answers, and bootstrap re-runs with your answers.
   When the work finishes mvpfy **starts the app itself** (`docker compose -f
   docker-compose.mvpfy.yml up -d`) — unless the agent left you questions, in which case it
   stops and shows them instead of running a half-configured stack. The app then polls the
   port and the last card turns *ready to test* once the app actually responds. Everything
   the agent generated stays on the Overview for you to read, and you can stop or restart
   the environment at any time.
3. **Ask mvpfy to change something** — describe any change in plain language:
   "Add an environment variable STRIPE_API_KEY=… to the backend", "move the app to port
   5000". The agent applies the smallest safe change (secrets go into the local env file,
   never into code), reports back in plain language, and offers a one-click restart when
   the environment needs it — and any product change can be shipped as a PR.
4. **Plan a feature** — the Plan tab. Describe the feature in a sentence or two; mvpfy
   studies your actual codebase and writes a **minimal PRD in the Feature1 style** —
   problem, solution, target users, success metrics, scope in/out, flows, requirements —
   plus **user stories** written as user outcomes, each with acceptance criteria and an
   estimate, every spec item covered by a story. The **PRD is shown first**: refine it in
   plain language until it reads right, and the story board opens once you agree. Plan as
   many features as you like — each gets its own board, and you can plan the next feature
   while another one's stories are still being implemented.
5. **Execute the stories** — each feature's stories live on its own board: **To do →
   Coding → Testing → Done**. Click *Implement* and the agent moves the story to Coding,
   implements every acceptance criterion with tests on its own branch, and opens a pull
   request — the story arrives in Testing with the PR attached. **You** test it in the
   live app and drag it to Done, or send it back with feedback in plain language and the
   agent re-runs with your notes. The agent never moves a story to Done — shipping is a
   human decision.

6. **Launch readiness** — a feature like any other, sitting in the Plan tab beside the ones
   you plan yourself, and mvpfy **starts it with the project**: it runs off the back of
   bootstrap, so a freshly added product opens on it. A prototype that runs on your machine
   is not a product strangers can use, and mvpfy is unusually well placed to say why: it built the
   local environment, so it knows which parts of your app are its own **stand-ins**, which
   settings are throwaway defaults, and where your data actually lives. It reads all of that
   plus your code and reports, in plain language, what would go wrong on launch day —
   graded, worst first: **blockers** (real people lose money, lose data, or get into
   something they shouldn't), **risks**, and notes. Every finding points at the file that
   proves it. The verdict is computed by mvpfy from the findings, never claimed by the
   agent, and the only way past a blocker is to fix it or explicitly *launch with this
   anyway* — which keeps it on the list, marked as your decision, because accepting a risk
   doesn't make it safe. Nothing in this step changes your code.

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
- Linked (in-place) projects live at the folder you chose; mvpfy confines itself to that
  folder's `.mvpfy/` subfolder for everything it generates, and agents/docker are allowed
  only in explicitly linked folders.

## Prompt templates

The curated prompts live in `src/prompts/`:

- `bootstrap-plan.txt` — read-only first pass: write the setup task list the PM watches.
- `launch-readiness.txt` — read-only audit: what stands between this and real users.
- `bootstrap-runtime.txt` — generate the Docker runtime files for a repo.
- `plan-spec.txt` — write the minimal PRD (Feature1-style) and the user-story plan.
- `plan-implement.txt` — implement one planned story end-to-end and open its PR.
- `instruct.txt` / `ship-change.txt` — apply a plain-language change / ship the workspace's
  changes as pull request(s).
- `triage.txt` — read a failed run's log, explain it in plain English, and fix the workspace.

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
