# mvpfy

Turn a Feature1 user story into a pull request with one click.

mvpfy is a minimal Electron desktop app for non-technical product managers. It is a **thin
wrapper over [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and
[Codex CLI](https://github.com/openai/codex)** — it does not reimplement any agent logic. It
handles setup checks, workspace management, curated prompts, and invoking the external CLI;
the agents do the actual engineering work.

> **Bring your own agent.** mvpfy shells out to `claude` and `codex`. You must have your own
> API keys / subscriptions for those tools, installed and authenticated on your machine.

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
2. **Add project** — paste a GitHub/GitLab repo URL. mvpfy clones it into
   `~/.mvpfy/projects/<slug>`.
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
4. **Implement a story** — refresh the story list (loaded from the Feature1 MCP server), click
   *Implement*. mvpfy invokes the agent with the ship-feature prompt: it loads the workflow,
   implements every acceptance criterion, runs the tests, commits, pushes, opens a PR with
   `gh`, and updates the Feature1 workflow via MCP. Output streams live into the log panel,
   and the PR URL is captured and shown when the run succeeds.

## Local state

- `~/.mvpfy/state.json` — tenant config, projects, settings.
- `~/.mvpfy/secrets.json` — `safeStorage`-encrypted tokens (never plaintext).
- `~/.mvpfy/projects/<slug>` — cloned repos (agents run sandboxed to these directories).

## Prompt templates

The curated prompts live in `src/prompts/`:

- `bootstrap-runtime.txt` — generate the Docker runtime files for a repo.
- `ship-feature.txt` — the "Ship with AO" flow: implement a Feature1 story end-to-end and
  open a PR. (This automates the manual copy-paste flow from the Feature1 settings panel.)

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
