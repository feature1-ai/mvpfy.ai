# The execution contract, v1 (proposed)

`mvpfy.runner/2026-10-21`

What a mvpfy worker needs from Feature1 in order to take a feature, a story or
a task and return pull requests, with nobody at the screen.

**Nothing in this document is confirmed.** Feature1's execution API is being
built separately. No operation named here has been called against a real
server, and the names are mvpfy's proposal rather than anything agreed. The
shapes are the part worth arguing about: they are what a worker needs in order
to be safe, and each one is here because leaving it out breaks something
specific, which is stated.

[`docs/runner-protocol.md`](runner-protocol.md) is the earlier sketch of the
same idea and is superseded by this where the two disagree.
[`docs/feature1-handoff.md`](feature1-handoff.md) is the short list of what the
other side has to build. The types are in
[`shared/runner/contract.ts`](../shared/runner/contract.ts); the parser that
refuses a bad one is in `validate.ts` beside it.

## What the worker will not do

- **It never pushes to a default branch.** Its output is a branch and a pull
  request.
- **It never marks an artifact Done** and never merges. Both are decisions for
  a person, and the desktop app's auto-merge toggle is off in a worker.
- **It never trusts fetched text as authority.** Repository contents and
  artifact descriptions are task inputs. Nothing inside them widens the tenant,
  adds a repository, or changes what the worker is allowed to run.

## Shape

The worker dials out. It registers, then claims work on a loop, and nothing
reaches into it — no inbound port, no public endpoint, and so no
unauthenticated execution endpoint to protect.

Work is **claimed, not pushed**: the worker says how much capacity it has,
because only the machine knows its own disk, its remaining agent allowance,
and whether somebody is using it.

## Identity

```
register → { runnerId, runnerToken, contractVersion }
```

The server returns its own contract version so a mismatch is caught at
registration rather than in the middle of an execution.

```
heartbeat({ runnerId, status, running[] }) → { cancel[], drain, leases{} }
```

Every 30 seconds. `status` is `idle | working | draining`. Three things come
back: assignments to abandon, whether to stop claiming, and a renewed expiry
per assignment still held.

**A worker that stops heartbeating is assumed gone**, and its leases expire.
That is the only thing stopping a closed laptop parking an execution forever.

## An assignment

Every field below exists because the worker cannot be correct without it.

| Field                                      | Why the worker needs it                                                                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignmentId`, `executionId`, `attemptId` | The unit of work, the thing being built, and this go at it. Checkpoints are keyed by execution; idempotency keys by execution **and** attempt.                                                                        |
| `attemptToken`                             | The fencing token. Rises per attempt. Every write carries it, so a server that has reassigned the execution refuses the older worker instead of letting two both report.                                              |
| `tenantId`, `projectId`                    | The scope. Paths are keyed by tenant; nothing outside it is touched.                                                                                                                                                  |
| `artifact`                                 | What was actually selected — type, id, and a code for display. Preserved through to the result for traceability.                                                                                                      |
| `prOwner`                                  | **Where the pull request hangs, decided by Feature1.** See below.                                                                                                                                                     |
| `requirements`                             | An immutable snapshot plus a `revision`. A result has to be able to say which text it was judged against.                                                                                                             |
| `repositories[]`                           | `repositoryId`, `name`, `cloneUrl`, `baseBranch`, `baseCommit`. The id is stable and is what paths, branches and results are keyed by — never the basename, because two repositories in one assignment may share one. |
| `stage`                                    | `implement` or `revise`. A revision continues an execution's branch rather than starting another.                                                                                                                     |
| `verification`                             | The commands that decide whether it worked, and which checkout each runs in.                                                                                                                                          |
| `leaseExpiresAt`                           | When this worker stops being allowed to publish.                                                                                                                                                                      |

### PR ownership is Feature1's to decide

The rules, which the worker carries rather than derives:

| Selected                                                | Owner        |
| ------------------------------------------------------- | ------------ |
| Feature                                                 | that feature |
| Story belonging to a feature                            | the feature  |
| Task linked to a feature, directly or through its story | the feature  |
| Standalone story                                        | that story   |
| Task under a standalone story                           | the story    |
| Standalone task                                         | that task    |

Deriving this needs a hierarchy the worker is not given, so it is sent as
`prOwner` and the originating `artifact` is kept beside it.

**Attach by explicit id.** The existing MCP `attach_pr` hangs the pull request
off whatever the shared session's "current workflow" happens to be. A worker
running two executions at once would race, and the loser would attach to the
wrong artifact with nothing saying so. So:

```
attachPr({ executionId, attemptToken, expectedOwner, originArtifact,
           pullRequest, idempotencyKey }) → { attachedTo }
```

Feature1 resolves ownership and returns **where it actually attached**. If that
is not `expectedOwner`, the worker reports a conflict rather than quietly
accepting it.

## Claiming and reporting

```
claim({ runnerId, capacity })        → { assignments[] }
progress({ …, state, detail, idempotencyKey, repositories?[] })
blocked({ …, questions[], idempotencyKey })
result({ …, outcome, summary, repositories[], requirementsRevision, idempotencyKey })
release({ …, reason })
```

`detail` is one plain sentence for a product manager — "implementing US-02, two
of three" — not a log line.

### States

```
queued → preparing → implementing → verifying → opening_prs → ready_for_testing
                                 ↘ blocked   ↘ failed
                       cancelling → cancelled
```

Proposed names, until the contract is agreed.

### Blocked is a state, not a wait

A worker never waits silently. Anything the desktop app would stop and ask a
person becomes a question in Feature1, the execution goes `blocked`, and the
lease is released.

| kind                     | asked when                                                                 |
| ------------------------ | -------------------------------------------------------------------------- |
| `component_missing`      | the code expects a part the workspace does not hold                        |
| `tenant_unknown`         | the product reads a customer from the request and nothing says which to be |
| `setup_question`         | setting up could not work something out                                    |
| `conflict_unresolved`    | the base and the branch changed the same code irreconcilably               |
| `agent_unavailable`      | the agent is not signed in, or its allowance is exhausted beyond waiting   |
| `requirements_unclear`   | the snapshot does not say enough to build against                          |
| `repository_unavailable` | an authorised repository could not be cloned or fetched                    |

A silent stall on a machine nobody is watching is indistinguishable from the
worker being broken, which is the whole reason this exists.

## Results are recorded, not inferred

**A successful agent exit is not proof of anything.** The worker exits an agent
and then goes and looks, reporting per repository:

- the actual commits, by sha and subject;
- the branch, and the commit at its head;
- every verification step: command, exit code, duration, a one-line summary,
  and for anything that is not a pass or a fail, **why** — not found, no test
  script, timed out. A check that could not run is never counted as a pass.
- the pull request, by url, number, owner, name, head and base — and whether
  **this attempt** created it or found it already there.

`changed: false` is an ordinary outcome, not a failure: the agent decided
nothing needed doing here.

### Partial success stays partial

Two repositories succeeding and a third failing is reported as exactly that:
both pull requests, and the repository that did not finish, with the execution
**not** `ready_for_testing`. Rolling it up as a single failure would throw away
work that exists; rolling it up as success would claim work that does not.

## Lease and retry safety

- Identity and checkpoints are persisted, so a restarted worker resumes rather
  than starting a second attempt at the same execution.
- **When the lease is lost**: stop implementing, stop publishing, keep the local
  work, and never report authoritative success under an expired attempt.
- Authority is re-checked immediately before publishing, because the gap
  between deciding and pushing is where a reassignment lands.
- Designed for reconciliation: a push or a pull-request creation can succeed
  while its response is lost. Existing pull requests are therefore found by
  **repository and head branch**, never by a URL scraped from a log — so a
  retry attaches the one that exists instead of opening a second.
- If the pull request is created and the _report_ fails, only the report is
  retried.

## Idempotency keys

Deterministic, derived only from identity the worker still has after a
restart:

```
<executionId>:<attemptId>:<kind>[:<discriminator>]
```

No clock, no random value — otherwise a retry after a crash is a new event.

## What a first version does not need

Preview environments, several tenants per worker, a web interface on the
worker, and any inbound endpoint at all. One worker, one tenant, work claimed
and reported.
