# Connecting a worker to Feature1

Both sides are built. This is what an operator does to join them, and what to
check when it does not work.

The contract itself is in [`runner-contract-v1.md`](runner-contract-v1.md).
Running the worker is in [`worker-docker.md`](worker-docker.md).

## Turning it on

1. **Migrate and enable, on the Feature1 server.** Apply the migrations, then
   set `MVPFY_IMPLEMENTATION_ENABLED=true`. Until that is set, every worker
   route answers **404** — which looks exactly like a bad credential, so check
   this first.

2. **Mint a credential.** An organisation admin posts to
   `/api/implementation-runs/runners/credentials` with a name. The response
   carries the token **once**. It is 64 hex characters and **expires after 24
   hours**.

3. **Give it to the worker** as `MVPFY_RUNNER_TOKEN`, with
   `MVPFY_FEATURE1_URL` pointing at the tenant. Never in an image layer, a
   command line, or a log. The worker registers it as a secret at start-up, so
   anything it prints has the value stripped.

4. **Queue something.** A member picks a feature, story or task and queues an
   implementation, choosing the repositories and base branches. The worker
   claims it within its claim interval.

## When it does not work

| What you see                                        | Almost certainly                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Every call 404s                                     | `MVPFY_IMPLEMENTATION_ENABLED` is not `true`                                                            |
| 401 after it worked yesterday                       | The credential expired; they last 24 hours                                                              |
| Worker starts, claims nothing, forever              | Nothing queued, or it is queued for a different tenant                                                  |
| Executions keep being reclaimed mid-flight          | Heartbeat slower than the three-minute lease. The worker refuses an interval above 120s for this reason |
| `Passing verification commands are required`        | The repository has no runnable check, or its suite failed. Neither can be handed over                   |
| `Every selected repository needs a verified result` | One repository did not finish; the others' pull requests are still attached                             |
| `Requirements changed during execution`             | Somebody edited the artifact while it was building. Review the pull requests and queue again            |

## The thing most likely to bite

**Feature1 accepts only green results.** A repository whose tests fail, or
which has no test command at all, cannot be reported — the execution fails
instead.

That is the right bar for an unattended builder, and it has a consequence
worth deciding deliberately: a worker pointed at a repository with no suite
will fail every time, having done the work and pushed nothing. If that
describes repositories you intend to use, the options are to give them a
command that genuinely means something, or to ask Feature1 for an explicit
"built, not verified" outcome. Inventing a check that always passes would
satisfy the server and defeat the point of it.

## Running it with nothing real

```sh
docker run --rm -e MVPFY_FAKE_FEATURE1=1 mvpfy-worker
```

The fake re-implements the rules the server actually enforces — the lease
comparison, the stage ordering, the green-results rule, the
every-repository rule, reclaim with results intact — so it exercises the
worker properly rather than agreeing with it. It is also what every test in
this repository runs against: no server, no network, no agent credit, no real
pull requests.
