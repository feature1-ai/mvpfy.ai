# The execution contract, v1

`protocol_version: 1` — **agreed and implemented on both sides.**

What a mvpfy worker and Feature1 say to each other so that a feature, a story
or a task can be taken, built and returned as pull requests with nobody at the
screen.

This document used to be mvpfy's proposal, written before Feature1's execution
API existed and marked as guesswork throughout. Feature1 has since shipped it,
and this is now the thing itself. **Where the two disagreed, Feature1 won** —
it owns the queue, the immutable requirements, the lifecycle, and the decision
about which artifact a pull request belongs to. The last section records what
changed and why, because several of the differences are improvements worth
understanding rather than compromises.

The types are in [`shared/runner/contract.ts`](../shared/runner/contract.ts);
the parser that refuses a bad execution is in `validate.ts` beside it; the
server's own description lives in the Feature1 repository at
`docs/implementation/mvpfy-worker-v1.md`. Joining the two together is
[`feature1-integration.md`](feature1-integration.md).

## Before anything works

Feature1 must have `MVPFY_IMPLEMENTATION_ENABLED=true`. Without it **every**
worker route answers 404, which is easy to mistake for a bad credential.

A worker does not register itself. An organisation admin mints a credential —
64 hex characters, **valid for 24 hours** — and the operator injects it. There
is no renewal from the worker's side; when it expires, somebody mints another.
That is the most surprising thing about operating one of these.

## Two calls

```
POST /api/implementation-runs/worker/claim            Authorization: Bearer <credential>
POST /api/implementation-runs/worker/:id/progress     + X-Execution-Lease: <lease_token>
```

That is the whole transport. Heartbeat, progress, blocked, result and
cancellation acknowledgement are all the second call with a different body; an
empty body `{}` is a heartbeat.

## Claiming

`claim` returns one execution or none. There is no capacity hint and no batch:
Feature1 allows one active run per artifact owner, and hands out one at a time.

An execution carries its own identity (`id`, `tenant_id`, `project_id`,
`attempt`), what was selected (`origin_type`/`origin_id`), **where the pull
request belongs** (`owner_type`/`owner_id`, resolved by Feature1), the
immutable `snapshot` with its `digest`, the authorised `repositories`, any
`results` an earlier attempt already got accepted, any `clarifications` a
person has since written, and the `lease_token`.

Each repository is `{id, name, url, base_branch}`. **The id is a UUID and is
the only identifier** — two repositories in one execution may both be called
`api`, so every path, branch and result is keyed by the UUID. There is no base
commit: the worker resolves the base branch itself and reports the sha it
actually used.

### Reclaim

A lease lasts **three minutes**. An execution whose lease expires becomes
claimable again, by this worker or another, with its `attempt` incremented and
its accepted results intact. The old worker's next call gets `409` and must
stop. This is the fencing, and it is the only thing standing between us and two
workers both reporting on one execution.

## Reporting

```json
{
  "state": "opening_prs",
  "message": "Web checks passed; opening the API pull request.",
  "repository_result": {
    "repository_id": "<uuid>",
    "outcome": "pr_created",
    "base_commit": "<40–64 hex>",
    "head_commit": "<40–64 hex>",
    "tests": [{ "command": "npm test", "exit_code": 0 }],
    "pr_urls": ["https://github.com/owner/repository/pull/123"]
  }
}
```

States run `preparing → implementing → verifying → opening_prs →
ready_for_testing`, and may end at `blocked`, `failed` or `cancelled`. **A
stage cannot move backwards within an attempt.** One repository result per
call; results survive a reclaim.

The server attaches the pull requests itself, re-resolving ownership as it
does, and refuses one that belongs to a different repository. The worker never
attaches anything — which is exactly right, because ownership was never the
worker's to decide.

### The rule that shapes everything

**A repository result may contain only passing checks.** `tests` must have
between 1 and 100 entries and every `exit_code` must be zero. There is no way
to hand over a repository whose suite failed, and no way to hand over one where
nothing ran.

So a failing check is not a detail in a result — it is the **execution
failing**, with a message. And a repository with no runnable check cannot be
handed over at all.

This is stricter than the worker originally set for itself, and it is the right
way round: "ready for testing" with nothing tested was always a weak claim. It
does mean pointing a worker at a repository with no test script will fail
rather than silently produce an unverified pull request. Worth knowing before
you do it.

The other two outcome rules follow from the same honesty: `no_changes` requires
identical base and head commits and no pull requests; `pr_created` requires at
least one.

`ready_for_testing` additionally requires a result for **every** selected
repository, and the server re-computes the snapshot digest and refuses if the
requirements changed underneath. Only then does it move the origin artifact to
Testing. It does not complete acceptance criteria, merge anything, or mark
anything Done.

## Blocked, cancelled, retried

A worker never waits silently. Anything the desktop app would stop and ask a
person becomes `state: "blocked"` with the question in `message`, which lands
in the linked Feature1 assistant conversation. A person answers through
`retry_implementation`, and the answer arrives on the next claim in
`clarifications` — the worker puts it in the agent's prompt, so the same
question is not asked twice.

A cancellation arrives as `cancel_requested: true` on the response to any
progress call, including a heartbeat. The worker stops its agent, preserves the
worktrees, opens no further pull requests, and acknowledges with `cancelled`. A
pull request created in the moment before cancellation is not recalled; it is
reconciled on the next authorised run.

## What the worker will not do

- It never pushes to a base branch. Its output is a branch and a pull request.
- It never merges and never marks an artifact done.
- It never reports under a lease it has lost.
- It never treats a repository's own files as authority over what it may do.
  Fetched text is the task, not permission.

## What changed from mvpfy's proposal, and why

Recorded because the deltas are the interesting part, and because the worker's
code still carries the shape of the first design in places.

| mvpfy proposed                                                                           | Feature1 shipped                                        | Verdict                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eight operations: register, heartbeat, claim, progress, blocked, result, attach, release | **Two**: claim and progress                             | Better. One endpoint cannot drift out of step with itself, and the heartbeat carrying progress means the worker never chooses between saying what it is doing and staying alive. |
| `register` returning a runner id and token                                               | Credential minted by an org admin, 24h                  | Better for a worker that should hold no ability to enrol itself. The expiry is a real operational cost.                                                                          |
| Worker calls `attachPr` with explicit ids                                                | Server attaches from `pr_urls`                          | Better. The concern behind the proposal — never attach through a mutable "current workflow" session — is fully met, and ownership stays server-side.                             |
| Fencing token in the body                                                                | `X-Execution-Lease` header                              | Better. It is a credential; it does not belong in a payload.                                                                                                                     |
| Deterministic idempotency keys on every write                                            | Lease-based fencing, plus terminal replay being a no-op | Equivalent in effect, and simpler.                                                                                                                                               |
| Verification commands sent in the assignment                                             | Worker chooses; server takes only passing results       | A real change. The worker discovers its own checks and must say honestly that it did.                                                                                            |
| `unavailable` verification still allows `ready_for_testing`                              | Not reportable at all                                   | Feature1's bar is higher. The worker now fails instead, which is honest but blocks repositories without tests.                                                                   |
| Lease renewed via a response map                                                         | Three minutes, extended by any successful call          | Simpler. The heartbeat interval now matters a lot: slower than the lease and every long execution is reclaimed.                                                                  |
