import { useState } from 'react';
import { ProjectController } from '../hooks/useProjectController';
import { PROVIDERS, PROVIDER_LABELS, Provider } from '../lib/launchPlan';
import {
  AREA_LABELS,
  groupByArea,
  ReadinessFinding,
  SEVERITY_LABELS,
  Severity,
} from '../lib/readiness';

interface Props {
  c: ProjectController;
  onOpenTab: (tab: 'app' | 'logs') => void;
}

const SEVERITY_BADGE: Record<Severity, string> = {
  blocker: 'bg-red-50 text-danger',
  risk: 'bg-warn-bg text-warn-text',
  note: 'bg-paper text-muted',
};

/**
 * Launch readiness: the gap between a prototype that runs on a laptop and a
 * product real people can use. Nothing here changes the code — it is the
 * honest list, and the decision about what to launch with is the builder's.
 */
export default function ReadinessPanel({ c, onOpenTab }: Props) {
  const v = c.readinessVerdict;
  const groups = groupByArea(c.readinessFindings);

  if (c.readinessRunning) {
    return (
      <div className="flex flex-col gap-5">
        <section className="card px-5 py-6">
          <div className="flex items-center gap-3">
            <span className="dot-pulse h-[9px] w-[9px] rounded-full bg-go" />
            <div>
              <h2 className="text-[15px] font-semibold">Checking what's left before launch…</h2>
              <p className="mt-0.5 text-[13px] text-body">
                Reading your code and everything mvpfy set up. This takes a minute or two.
              </p>
            </div>
            <button
              onClick={() => onOpenTab('logs')}
              className="btn-secondary ml-auto h-[34px] px-3.5"
            >
              View logs
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (!v) {
    return (
      <div className="flex flex-col gap-5">
        <section className="card px-5 py-8 text-center">
          <h2 className="text-[15px] font-semibold">Is this ready for real users?</h2>
          <p className="mx-auto mt-1.5 max-w-[520px] text-[13px] leading-relaxed text-body [text-wrap:pretty]">
            A prototype that runs on your machine is not the same as a product strangers can use.
            mvpfy knows which parts of this app are its own stand-ins, which settings are throwaway
            defaults, and where your data actually lives — it reads all of that plus your code, and
            tells you plainly what would go wrong on launch day.
          </p>
          <button
            onClick={() => void c.checkReadiness()}
            disabled={c.busy}
            className="btn-primary mt-5 h-[36px] px-4 text-sm disabled:opacity-50"
          >
            Check launch readiness
          </button>
          {!c.hasMvpfyYml && (
            <p className="mt-3 text-[12.5px] text-muted">
              Set the app up first — the check is much sharper once mvpfy has run it.
            </p>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {c.actionError && (
        <div className="rounded-lg border border-danger/30 bg-red-50 px-4 py-2.5 text-[13px] text-danger">
          {c.actionError}
        </div>
      )}

      {/* Verdict — computed by mvpfy from the findings, not claimed by the agent */}
      <section className={`card overflow-hidden ${v.kind === 'ready' ? 'border-go-border' : ''}`}>
        <div
          className={`flex items-start gap-4 px-5 py-[18px] ${v.kind === 'ready' ? 'bg-go-bg' : 'bg-surface'}`}
        >
          <span
            className={`mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full ${
              v.kind === 'not-ready'
                ? 'bg-danger'
                : v.kind === 'your-call'
                  ? 'bg-warn-border'
                  : 'bg-go'
            }`}
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{v.title}</h2>
            <p className="mt-0.5 text-[13px] leading-normal text-body">{v.detail}</p>
            {c.readinessSummary && (
              <p className="mt-2 text-[12.5px] text-muted">{c.readinessSummary}</p>
            )}
          </div>
          <button
            onClick={() => void c.checkReadiness()}
            disabled={c.busy}
            className="btn-secondary h-[34px] shrink-0 px-3.5 disabled:opacity-50"
            title="Read the code again and rebuild this list"
          >
            Check again
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-6 border-t border-line px-5 py-3.5">
          <Count label="Blockers" value={v.blockers} danger={v.blockers > 0} />
          <Count label="Risks" value={v.risks} />
          {v.accepted > 0 && (
            <Count label="Accepted by you" value={v.accepted} danger={v.acceptedBlockers > 0} />
          )}
          <span className="ml-auto text-[11px] text-faint">Nothing here changes your code.</span>
        </div>
      </section>

      <LaunchSection c={c} />

      {groups.map(({ area, findings }) => (
        <section key={area} className="card">
          <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
            <span className="section-label">{AREA_LABELS[area]}</span>
            <span className="text-[11px] text-faint">
              {findings.length} item{findings.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="divide-y divide-line-subtle">
            {findings.map((f) => (
              <Finding key={f.id} c={c} finding={f} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * The launch half: what going live would create and cost. Gated on readiness,
 * because launching a product with open blockers is the exact thing the rest
 * of this panel exists to prevent.
 */
function LaunchSection({ c }: { c: ProjectController }) {
  const [provider, setProvider] = useState<Provider>('fly');
  const plan = c.launchPlan;

  if (!c.launchGate.allowed) {
    return (
      <section className="card px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-dot-idle" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-muted">Going live</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              {c.launchGate.reasons.join(' ')}
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (c.launchPlanning) {
    return (
      <section className="card px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="dot-pulse h-[9px] w-[9px] rounded-full bg-go" />
          <div>
            <h2 className="text-[14px] font-semibold">Working out what it would cost…</h2>
            <p className="mt-0.5 text-[12.5px] text-body">
              Reading what your product needs and pricing the smallest real deployment.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (!plan) {
    return (
      <section className="card px-5 py-5">
        <h2 className="text-[15px] font-semibold">Ready to put this online?</h2>
        <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-body [text-wrap:pretty]">
          mvpfy can work out what hosting this product actually involves — which pieces get created,
          what each one costs per month, and which keys you need to go and get. It reads your setup
          and prices it. Nothing is created and no account is touched.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              onClick={() => setProvider(p)}
              className={`h-7 rounded-full border px-3 text-xs transition-colors ${
                provider === p
                  ? 'border-ink bg-ink text-white'
                  : 'border-line bg-surface text-body hover:border-muted'
              }`}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
          <button
            onClick={() => void c.planLaunch(provider)}
            disabled={c.busy}
            className="btn-primary ml-1 h-[30px] px-3 text-xs disabled:opacity-50"
          >
            What would it cost?
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card overflow-hidden">
      <div className="flex items-start gap-4 border-b border-line bg-surface px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">
            Going live on {PROVIDER_LABELS[plan.provider]}
          </h2>
          {plan.summary && <p className="mt-0.5 text-[13px] text-body">{plan.summary}</p>}
          <p className="mt-1 text-[12px] text-muted">
            {plan.appName}
            {plan.region && ` · ${plan.region}`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="section-label">Roughly</div>
          <div className="font-mono text-[17px] font-medium">${c.launchMonthlyUsd.toFixed(2)}</div>
          <div className="text-[11px] text-muted">per month</div>
        </div>
      </div>

      <div className="divide-y divide-line-subtle px-5">
        {plan.resources.map((r) => (
          <div key={r.id} className="flex items-baseline gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">
                {r.name} <span className="font-normal text-muted">· {r.kind}</span>
              </p>
              {r.detail && <p className="mt-0.5 text-[12.5px] text-body">{r.detail}</p>}
            </div>
            {r.size && <span className="shrink-0 font-mono text-[11px] text-faint">{r.size}</span>}
            <span className="w-16 shrink-0 text-right font-mono text-[12.5px]">
              ${r.monthlyUsd.toFixed(2)}
            </span>
          </div>
        ))}
      </div>

      {c.launchSecretsFromYou.length > 0 && (
        <div className="border-t border-line px-5 py-4">
          <span className="section-label">You need to get these first</span>
          <div className="mt-2 grid gap-1.5">
            {c.launchSecretsFromYou.map((s) => (
              <p key={s.key} className="text-[12.5px] text-body">
                <span className="font-mono text-ink">{s.key}</span> — {s.why}
              </p>
            ))}
          </div>
        </div>
      )}

      {plan.steps.length > 0 && (
        <div className="border-t border-line px-5 py-4">
          <span className="section-label">What would happen</span>
          <ol className="mt-2 grid gap-1">
            {plan.steps.map((step, i) => (
              <li key={i} className="flex gap-2.5 text-[12.5px] text-body">
                <span className="font-mono text-[11px] text-faint">{i + 1}</span>
                {step}
              </li>
            ))}
          </ol>
        </div>
      )}

      {plan.notes.length > 0 && (
        <div className="border-t border-line px-5 py-4">
          <span className="section-label">Worth knowing</span>
          <div className="mt-2 grid gap-1">
            {plan.notes.map((n, i) => (
              <p key={i} className="text-[12.5px] text-body">
                {n}
              </p>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line bg-sunken px-5 py-3.5">
        <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">
          An estimate from {PROVIDER_LABELS[plan.provider]}&apos;s public pricing, totalled by mvpfy
          — check it against their site before you commit. mvpfy cannot create these for you yet, so
          this is the shopping list: it is accurate enough to work through by hand.
        </p>
        <button
          onClick={() => void c.planLaunch(plan.provider)}
          disabled={c.busy}
          className="btn-secondary h-[30px] shrink-0 px-3 text-xs disabled:opacity-50"
        >
          Work it out again
        </button>
      </div>
    </section>
  );
}

function Finding({ c, finding }: { c: ProjectController; finding: ReadinessFinding }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const fixing = c.fixingFindingId === finding.id;
  const someoneElseFixing = c.fixingFindingId !== null && !fixing;
  return (
    <div className={`px-5 py-4 ${finding.accepted ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">{finding.title}</p>
          {finding.detail && (
            <p className="mt-1 text-[12.5px] leading-relaxed text-body [text-wrap:pretty]">
              {finding.detail}
            </p>
          )}
          {finding.fix && (
            <p className="mt-1.5 text-[12.5px] text-body">
              <span className="text-muted">To fix — </span>
              {finding.fix}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {finding.fixableBy === 'mvpfy' && !finding.accepted && (
              <button
                onClick={() => void c.fixFinding(finding.id)}
                disabled={c.busy || someoneElseFixing}
                title="mvpfy makes the change, then re-runs the check to confirm it worked"
                className="btn-primary h-6 px-2.5 text-[11.5px] disabled:opacity-50"
              >
                {fixing ? 'Fixing…' : 'Fix this'}
              </button>
            )}
            {finding.fixableBy === 'you' && !finding.accepted && (
              <span
                className="text-[11.5px] text-muted"
                title="This needs something only you can get or decide — a real account, key, host or policy"
              >
                needs you
              </span>
            )}
            {finding.evidence.length > 0 && (
              <button
                onClick={() => setShowEvidence((p) => !p)}
                className="text-[11.5px] text-go hover:text-go-hover hover:underline"
              >
                {showEvidence ? 'Hide where' : 'Show where'}
              </button>
            )}
            {finding.accepted ? (
              <button
                onClick={() => void c.unacceptFinding(finding.id)}
                className="text-[11.5px] text-muted hover:text-ink"
              >
                Undo — I do want to fix this
              </button>
            ) : (
              <button
                onClick={() => void c.acceptFinding(finding.id)}
                className="text-[11.5px] text-muted hover:text-ink"
                title="Keeps it on the list, marked as your decision — it does not make it safe"
              >
                Launch with this anyway
              </button>
            )}
          </div>
          {showEvidence && (
            <ul className="mt-2 grid gap-1">
              {finding.evidence.map((e, i) => (
                <li key={i} className="font-mono text-[11.5px] text-muted">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${SEVERITY_BADGE[finding.severity]}`}
        >
          {finding.accepted
            ? `${SEVERITY_LABELS[finding.severity]} · accepted`
            : SEVERITY_LABELS[finding.severity]}
        </span>
      </div>
    </div>
  );
}

function Count({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div>
      <div className="section-label">{label}</div>
      <div className={`font-mono text-[13px] ${danger ? 'text-danger' : ''}`}>{value}</div>
    </div>
  );
}
