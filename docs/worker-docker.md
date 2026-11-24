# Running a mvpfy worker

A worker is a headless builder. It claims work from Feature1, implements it in
isolated checkouts, verifies it, opens pull requests, and reports. It has no
window, no web interface, and nothing listening — every connection it makes is
outbound.

It is not the desktop app and does not replace it. The desktop app is a person
at a screen; this is the same factory with nobody there.

## Build

```sh
docker build -f Dockerfile.worker -t mvpfy-worker .
```

The image carries `git`, the GitHub CLI, **both coding agents** (Claude Code
and Codex, so `MVPFY_AGENT` can select either), and the compiled worker. It has **no `node_modules`**: the worker imports only node builtins and
its own files, so there is nothing else to ship or to patch.

Built and smoke-tested — it runs as uid 10001, starts read-only with only a
tmpfs for `/tmp`, claims against the fake, and drains on `SIGTERM`.

## Run

```sh
docker run -d --name mvpfy-worker \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --tmpfs /home/mvpfy:rw,nosuid,uid=10001,gid=10001,size=256m \
  -v mvpfy-work:/var/lib/mvpfy \
  -e MVPFY_FEATURE1_URL=https://acme.feature1.ai \
  -e MVPFY_RUNNER_TOKEN=<64 hex, from an organisation admin> \
  -e GH_TOKEN=... \
  -e ANTHROPIC_API_KEY=... \
  mvpfy-worker
```

### Set up once, then run

Instead of handing the worker a runner credential and a `GH_TOKEN`, sign it in
once. The sign-ins are kept on the worker's volume, so the container can be
replaced and still be signed in.

```sh
docker run --rm -it -v mvpfy-worker:/var/lib/mvpfy mvpfy-worker setup
```

Setup is the desktop app's onboarding for a machine with no window. Each step
prints a code and an address to open on any other device:

1. **GitHub** — `gh`'s own browser sign-in.
2. **The coding agent** — Claude Code's sign-in, or Codex's device sign-in when
   `MVPFY_AGENT=codex`. Skipped when an API key is already in the environment.
3. **Feature1** — the workspace address and a personal token from Feature1 →
   Settings, belonging to an organisation admin. The token is checked against
   the workspace, used once to add this runner, and not kept. What is kept is
   the runner credential it obtained, in `runner.json` on the volume.

After each step setup checks that the sign-in actually took, and it reports
that check rather than the command's exit. Steps already in place are left
alone, so running it again only does what is missing.

Then run the worker with no credentials in its environment:

```sh
docker run -d --name mvpfy-worker -v mvpfy-worker:/var/lib/mvpfy mvpfy-worker
```

Three things to know:

- **The runner credential lasts 24 hours.** That is Feature1's rule. The worker
  refuses to start on a lapsed one and says so; run `setup` again to renew it.
  Setup renews one with less than an hour left. A runner that should stay up
  unattended needs this renewed on a schedule until Feature1 issues longer
  ones.
- **The GitHub sign-in is a person's.** The worker reads the token from `gh` at
  start-up and gives it to its own clone, fetch and push only. The agent's
  environment has `GH_CONFIG_DIR` removed, so `gh` inside an agent run is signed
  out — though, as [Isolation](#isolation) says, that is a narrowing and not a
  boundary while agent and worker run as the same user.
- **Variables still win.** `MVPFY_FEATURE1_URL`, `MVPFY_RUNNER_TOKEN` and
  `GH_TOKEN` override what setup saved. To script the Feature1 step, set
  `MVPFY_FEATURE1_URL` and `MVPFY_FEATURE1_TOKEN` for the `setup` run.

### Configuration

| Variable                      | Default                  | What it is                                                                                                                                                                                          |
| ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MVPFY_FEATURE1_URL`          | — required unless faking | The tenant's Feature1 URL. Must be https, except `localhost`.                                                                                                                                       |
| `MVPFY_RUNNER_TOKEN`          | — required unless faking | The 64-hex runner credential, minted by an organisation admin and **valid for 24 hours**. The worker cannot renew it. Registered as a secret at start-up, so it never appears in a log or a report. |
| `MVPFY_WORKER_ROOT`           | `/var/lib/mvpfy`         | Everything durable. Mount it.                                                                                                                                                                       |
| `MVPFY_AGENT`                 | `claude`                 | `claude` or `codex`.                                                                                                                                                                                |
| `MVPFY_AGENT_MODEL`           | the agent's own          | Leave unset to use whatever the agent is configured with.                                                                                                                                           |
| `MVPFY_CLAIM_INTERVAL_MS`     | `15000`                  | How often it asks for work when idle.                                                                                                                                                               |
| `MVPFY_HEARTBEAT_INTERVAL_MS` | `45000`                  | How often it renews the lease while working. The lease is three minutes, so anything above 120000 is refused.                                                                                       |
| `MVPFY_UNIT_ATTEMPTS`         | `3`                      | Tries each story gets before the execution fails: the first build, then repairs fed the failing check's output. `1` turns repair off. At most 5.                                                    |
| `MVPFY_WORKER_NAME`           | `mvpfy worker`           | For this worker's own logs.                                                                                                                                                                         |
| `MVPFY_FAKE_FEATURE1`         | —                        | `1` runs against the in-process fake. No server, no credential, nothing real.                                                                                                                       |

There is no tenant setting and no concurrency setting: the credential decides
the tenant, and Feature1 hands out one execution at a time.

A bad configuration stops the worker at start-up rather than an hour later in
the middle of somebody's execution.

### Agent authentication

The worker runs whichever agent it is configured with, and that agent needs its
own credential. **Supported today:**

- **Claude Code** — `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` plus a gateway
  credential. An interactive subscription sign-in is not usable here: it is a
  browser flow, and nobody is at a browser.
- **Codex** — `OPENAI_API_KEY`, same reasoning.
- **GitHub** — `GH_TOKEN` with `repo` scope on the repositories the assignment
  authorises, for cloning, pushing and opening pull requests.

If Feature1 issues credentials with the claim (see
[`runner-contract-v1.md`](runner-contract-v1.md#credentials-in-the-claim)),
`GH_TOKEN` is not needed: the execution brings a token scoped to its own
repositories, and that one is used in preference to anything set here.

All of them are passed as environment variables and none is baked into the
image. All of them are registered with the redactor at start-up, so a value
that appears in an agent's output or a test failure is replaced before it is
reported.

### What is mounted, and what is not

- **`/var/lib/mvpfy`** holds the bare clones, each execution's worktrees, and
  the checkpoints. Mount it on a volume: without it a restart loses work that
  was in flight, and a lost checkpoint is how an execution opens a second pull
  request.
- **Nothing else.** The worker never touches a developer's working copy. Every
  checkout is made by the worker, under
  `/var/lib/mvpfy/executions/<tenantId>/<executionId>/repos/<repositoryId>/`, keyed by
  stable ids rather than names — two repositories in one assignment may both be
  called `api`.
- **Not the host Docker socket.** Mounting it would hand the agent control of
  the daemon, which is control of the host. If an execution needs containers,
  give the worker its own nested runtime; do not give it yours.

## How a feature is built

One story at a time, each checked before the next is started. After a story
the worker runs the checks of every repository whose branch moved. If one
fails, the same story goes back to the agent with the failing command and the
end of its output, up to `MVPFY_UNIT_ATTEMPTS` tries in all.

A story that still fails after that stops the execution, named in the message
a person reads. Nothing is pushed and no pull request is opened: the stories
after it were never built, and the commits stay in the checkout for a retry.

A repository is not re-checked at a commit it already passed at, so the
verify stage before publishing costs nothing when the last story left the
branch where its checks ran.

## Isolation

Read this part before running a worker on anything you care about.

The worker runs a coding agent with broad permissions — `claude` with
`--dangerously-skip-permissions`, `codex` with `--sandbox
danger-full-access`. That is deliberate and it is the only way an unattended
builder works: an agent that stops to ask cannot run with nobody there. The
consequence is that **everything inside the container is reachable by code the
agent writes or runs**, including the repositories' own build scripts.

So the container is the security boundary, not the agent. What that requires:

- **Non-root.** The image runs as uid 10001 and the entrypoint does not change
  that. Do not run it with `--user root`.
- **One tenant per worker.** The runner credential belongs to one tenant and
  authorises only the two worker endpoints, never general Feature1 APIs. Run a
  separate worker per tenant: two sharing one means one tenant's agent can
  reach the other's checkouts and tokens, and no server-side scoping helps
  once they share a filesystem.
- **A boundary you would trust with untrusted code.** The default Docker
  isolation is a shared kernel. For work from a tenant you do not fully trust,
  run the worker on a dedicated VM, or under gVisor or Kata — the same decision
  any CI runner that executes customer code has to make.
- **Egress worth limiting.** The worker needs Feature1, GitHub, the agent's
  API, and whatever the repositories' package managers fetch. An allowlist is
  worth the trouble; it is the difference between a compromised build script
  reading your network and reading nothing.
- **No inbound anything.** There is no port, no `EXPOSE`, and no execution
  endpoint. Do not add one: the outbound-only shape is why the worker needs no
  authentication surface of its own.

## Stopping it

`SIGTERM` drains: the worker stops claiming, lets what is running finish and
report, then exits. That matters more than it sounds — an execution killed
halfway leaves a branch pushed and nothing reported, which is the state that
costs a person the most time to untangle.

A second `SIGTERM` cancels the executions in flight. They still report, as
`cancelled`.

Give it a real grace period:

```sh
docker stop --time 600 mvpfy-worker
```

## Checking it without Feature1

```sh
docker run --rm -e MVPFY_FAKE_FEATURE1=1 mvpfy-worker
```

The fake is the same one every test uses, and it re-implements the rules the
real server enforces: the lease comparison, the stage ordering, the
green-results rule, the every-repository rule, and reclaim with the accepted
results intact. It exercises the worker rather than agreeing with it.

## What a worker will not do

- It never pushes to a default branch.
- It never merges, and never marks an artifact done. The desktop app's
  auto-merge toggle has no effect here; the worker has no code path that merges.
- It never reports success under a lease it has lost.
- It never treats a repository's own files as instructions about what it is
  allowed to do.
