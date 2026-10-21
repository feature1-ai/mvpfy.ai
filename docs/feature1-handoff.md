# Handoff: what Feature1 has to build

For whoever is building the Feature1 side. The mvpfy worker is written and
tested, end to end, against an in-process fake. This is the list of what has
to exist on your side for it to talk to something real, and the decisions
still open.

Read [`docs/runner-contract-v1.md`](runner-contract-v1.md) for the shapes and
the reasoning. The types are in
[`shared/runner/contract.ts`](../shared/runner/contract.ts); the fixtures the
worker is tested against are in `fixtures.ts` beside it, and they are the
cheapest way to see a real payload.

**Nothing has been called against a real server.** Every path below is
mvpfy's proposal. They are configuration on our side — a rename costs you
nothing.

## The eight operations

Current proposed paths, from `worker/httpTransport.ts`:

| Operation   | Proposed path                                 | Who calls when                         |
| ----------- | --------------------------------------------- | -------------------------------------- |
| `register`  | `POST /api/v1/execution/runners/register`     | Worker, once at start-up               |
| `heartbeat` | `POST /api/v1/execution/runners/heartbeat`    | Worker, every 30s                      |
| `claim`     | `POST /api/v1/execution/assignments/claim`    | Worker, every 15s when it has capacity |
| `progress`  | `POST /api/v1/execution/assignments/progress` | Worker, on each state change           |
| `blocked`   | `POST /api/v1/execution/assignments/blocked`  | Worker, when it must ask               |
| `result`    | `POST /api/v1/execution/assignments/result`   | Worker, once at the end                |
| `attachPr`  | `POST /api/v1/execution/pull-requests/attach` | Worker, per pull request               |
| `release`   | `POST /api/v1/execution/assignments/release`  | Worker, giving work back               |

All `POST`, all JSON, all bearer-authenticated with the runner token, all
carrying `contractVersion`.

## The five things the worker needs you to get right

These are not style preferences. Each one is something the worker cannot
compensate for from its side.

**1. Fence the attempts.** Every write carries `attemptToken`. If the
execution has been handed to a newer attempt, reject the older one with
`409`, `412` or `423` — the worker treats those as "you no longer own this"
and stops without reporting. Anything else and two workers both report on one
execution, with the later arrival winning by accident.

**2. Honour the idempotency keys.** Deterministic, of the form
`<executionId>:<attemptId>:<kind>[:<discriminator>]`. A worker that is killed
between sending a result and recording that it sent one will send it again on
restart. If that creates a second result, a second attachment or a second
notification, the retry is worse than the crash.

**3. Resolve PR ownership yourself, and say what you did.** `attachPr` carries
`expectedOwner` (what the assignment said) and `originArtifact` (what was
actually selected). You resolve, you attach, and you return `attachedTo`. If
it differs from `expectedOwner`, the worker reports a conflict rather than
accepting it — silently hanging a pull request off the wrong artifact is the
kind of error nobody finds for weeks. The rules we encoded are in the
contract; if ours are wrong, yours win, because you hold the hierarchy.

**4. Attach by explicit id, not by session.** The existing MCP `attach_pr`
hangs the pull request off whatever the shared session's current workflow
happens to be. A worker running two executions at once would race and the
loser would attach to the wrong artifact. This operation has to take ids.

**5. Send an immutable requirements snapshot with a revision.** The worker
reports `requirementsRevision` with its result, so the record says which text
the work was judged against. It also refuses to resume a checkpoint whose
revision no longer matches — that is different work wearing the same
execution id.

## What the worker will never do

Worth knowing before you design around it:

- It never pushes to a default branch, never merges, and never marks an
  artifact done. Those are yours and the reviewer's.
- It never reports `ready_for_testing` when a check it ran came back failing.
- It **does** report `ready_for_testing` when a check could not run at all —
  a repository with no test script, a missing command. Nothing failed, and
  calling that a failure would state something untrue about work that may be
  fine. The per-step results say `unavailable` with a reason, and the summary
  says "not everything could be checked". If you want that surfaced
  differently in your UI, the data is there.
- It never sends a log. Logs stay on the worker. What crosses is a one-line
  summary, structured results, and the questions when it is blocked — all
  passed through a redactor first.
- It never accepts an assignment for another tenant, and gives it straight
  back with a reason.

## Partial results are normal, and must not be flattened

Two repositories succeeding and a third failing is reported as exactly that:
two `pullRequest` records, one `error`, and the execution **not**
`ready_for_testing`. Please store it that way. Rolling it up to a single
failure throws away two real pull requests somebody now has to find by hand.

`changed: false` is also normal: the agent decided that repository needed
nothing. It is not a failure and should not read as one.

## Open decisions

Things we had to pick a side on. Any of them can change — they are cheap now
and expensive later.

1. **Paths and the operation split.** Eight endpoints is our guess. If you
   would rather have one `POST /execution/events` with a discriminator, say
   so; it is a small change here.
2. **Lease length.** We assume minutes and renew on every heartbeat. What is
   the server-side default, and what happens to an execution whose worker
   goes quiet mid-implementation — reassign immediately, or hold?
3. **Who decides `verification`.** Right now the assignment names the
   commands. Should Feature1 hold them per repository, or should the worker
   discover them and report what it found? Both work; the worker marks
   discovered checks as `discovered` either way.
4. **Blocked answers.** The contract says answers come back as a new
   assignment at the stage that was interrupted. That means a new `attemptId`
   and a new token. Confirm, because the worker's resume logic depends on it.
5. **`repositoryId` stability.** We key clones, worktrees, branches and
   results on it, and two repositories in one assignment may share a name. It
   has to be stable across assignments and never reused for a different
   repository.
6. **Cancellation semantics.** We treat `heartbeat.cancel` as "stop, report
   `cancelled`, keep the branch". Confirm you do not also want the branch
   deleted — we would rather not delete work by default.
7. **Who registers a runner.** Scion's join-token flow is a good model: a
   single-use token, consumed in the same transaction that stores the
   runner's secret, so a build host never holds a user credential. Worth
   copying if you have no view.

## Trying it without us

```sh
docker build -f Dockerfile.worker -t mvpfy-worker .
docker run --rm -e MVPFY_TENANT_ID=acme -e MVPFY_FAKE_FEATURE1=1 mvpfy-worker
```

That runs the whole worker against the in-process fake — no server, no
network, no agent credit spent. `worker/fakeFeature1.ts` is a readable
reference implementation of the server side, including the fencing and the
idempotency behaviour, and `worker/engine.test.ts` is the list of situations
it is expected to survive.
