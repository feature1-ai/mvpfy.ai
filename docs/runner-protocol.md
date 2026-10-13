# The runner protocol

How a machine running mvpfy takes work from Feature1 and builds it, with nobody
pressing the buttons.

This is mvpfy's side of the contract: the verbs it calls, the states it reports,
and the rules it holds itself to. It is written so the other side can be built
against it. Payload shapes are a proposal; the states and the rules are not —
they are what makes an unattended builder safe to leave alone.

## Shape

**The runner dials out.** It registers, then asks for work on a loop. Nothing
reaches into it: no inbound port, no tunnel, no firewall change, no public
endpoint, and so no authentication surface of its own. This is the model behind
every self-hosted CI runner, and it is chosen for the same reason.

**The same protocol serves a laptop, a box in a customer's network, and a
container somebody hosts.** Where the runner lives is an operational decision,
not a protocol one. That is the point of writing it down before hosting
anything.

**Work is claimed, not pushed.** A runner takes what it has capacity for and
holds a lease on it. A runner that dies holds nothing for long.

## Identity

A runner registers once and keeps a token. It is a machine, not a person: the
human who installed it is recorded, and everything it does afterwards is
attributable to the runner plus the person who asked for the feature.

```
register_runner({
  name,              // "Abdul's MacBook", shown in Feature1
  version,           // mvpfy version, so old runners are not handed new work
  capabilities: {
    repos: [...],    // repositories this machine can already build
    agents: [...],   // "claude" | "codex" — what is installed and signed in
    concurrency,     // how many features it will run at once (mvpfy caps at 3)
  },
}) -> { runner_id, runner_token }
```

`repos` is the honest answer to "what can this machine actually do". A runner
that has never cloned a repository cannot be handed a feature in it — or rather
it can, and will spend ten minutes failing. Capability matching is not a nicety.

```
heartbeat({ runner_id, status, running: [assignment_id] }) -> { directives }
```

Every 30 seconds. `status` is `idle` | `working` | `paused`. Two things come
back: whether a claim should be abandoned (someone cancelled it in Feature1),
and whether the runner should stop taking new work (draining, before a laptop
is closed deliberately).

**A runner that stops heartbeating is assumed gone.** Its claims expire and the
work is offered to somebody else. A closed laptop must not park a feature
forever, and this is the only mechanism that prevents it.

## Taking work

```
claim_work({ runner_id, capacity }) -> [ { assignment_id, feature_ref, stage, lease_expires } ]
```

`capacity` is how many more features this runner will accept right now, so the
decision about load stays with the machine that knows its own CPU, disk and
remaining agent allowance.

`stage` says what is being asked for, because the work is not always from the
beginning:

| stage       | what the runner does                                             |
| ----------- | ---------------------------------------------------------------- |
| `plan`      | pull the feature, write the spec and stories, stop for agreement |
| `implement` | work through the agreed stories, one after another               |
| `revise`    | apply review feedback to a branch that already exists            |

**Exactly one runner holds an assignment at a time**, enforced by the lease. A
runner renews the lease through its heartbeat; if it cannot, it loses the claim
rather than racing another machine in the same repository.

## Reporting

```
report_progress({ assignment_id, state, detail, usage? })
```

`detail` is one plain sentence for a product manager — "implementing US-03,
four of six" — not a log line. `usage` carries input, output and cached tokens,
so cost per feature is measured where the money is spent rather than estimated
later.

The states an assignment moves through:

```
claimed → planning   → awaiting_agreement
        → implementing → raising → raised
        → blocked
        → failed
        → released
```

`raised` is where a runner's job ends. Merging is a human's, and so is
accepting the feature.

## Blocked is a state, not a wait

**A runner never waits silently.** Everything mvpfy would normally stop and ask
a person at the screen becomes a question visible in Feature1, with the
assignment marked `blocked` and the lease released.

```
report_blocked({ assignment_id, questions: [ { id, kind, text, options? } ] })
```

The questions that actually occur, all of which exist in mvpfy today:

| kind                  | asked when                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `component_missing`   | the code expects a part the workspace does not hold — another repository, an address, a stand-in, or not wanted |
| `tenant_unknown`      | the product reads a customer from the request and nothing says which one to be here                             |
| `setup_question`      | setting up could not work something out and wrote its questions down                                            |
| `conflict_unresolved` | the trunk and the feature changed the same code in ways that could not be combined                              |
| `agent_unavailable`   | the agent is not signed in, or its allowance is exhausted beyond waiting                                        |

This is the rule the whole protocol turns on. Every one of these is correct
behaviour with somebody at the screen and a silent stall without one — and a
silent stall on a machine nobody is looking at is indistinguishable from the
runner being broken. Answers come back as a new assignment at the stage that
was interrupted.

## Finishing

```
report_result({ assignment_id, outcome, pr_urls: [...], usage, summary })
```

`outcome` is `raised` | `failed` | `abandoned`. A failure says which story and
why in one sentence; the log stays on the runner, where the person who owns the
machine can read it, and is not shipped anywhere by default.

```
release({ assignment_id, reason })
```

Given back deliberately — the machine is shutting down, the repository is gone,
the agent is signed out. Better than a lease expiring, because it says why.

## Rules the runner holds itself to

- **Nothing is implemented without an agreed PRD.** The gate moves to Feature1;
  it does not disappear.
- **One feature, one branch, one checkout.** Features run side by side, never
  in the same working copy — which is already how mvpfy works.
- **Never push to the trunk.** The runner's output is a pull request.
- **Every claim is idempotent.** A retried claim after a lost response must not
  produce a second branch or a second pull request; the assignment id is the
  key.
- **An exhausted allowance is a wait, not a failure.** The runner sleeps until
  the agent says it is back and carries on by itself, reporting that it is
  waiting and until when.
- **Credentials stay on the runner.** The token that raises pull requests, the
  repositories, and the product's own secrets never travel to Feature1.

## What a first version does not need

Preview environments, hosted execution, a web interface on the runner, and
multiple tenants per runner. One machine, one tenant, work claimed and
reported. Everything above is enough to have a feature described by a product
manager arrive as a pull request with nobody touching the builder — which is
the only thing worth proving first.
