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
  -v mvpfy-work:/var/lib/mvpfy \
  -e MVPFY_FEATURE1_URL=https://acme.feature1.ai \
  -e MVPFY_RUNNER_TOKEN=<64 hex, from an organisation admin> \
  -e GH_TOKEN=... \
  -e ANTHROPIC_API_KEY=... \
  mvpfy-worker
```

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
  `/var/lib/mvpfy/executions/<tenantId>/<executionId>/<repositoryId>/`, keyed by
  stable ids rather than names — two repositories in one assignment may both be
  called `api`.
- **Not the host Docker socket.** Mounting it would hand the agent control of
  the daemon, which is control of the host. If an execution needs containers,
  give the worker its own nested runtime; do not give it yours.

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
