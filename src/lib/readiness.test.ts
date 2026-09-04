import { describe, expect, it } from 'vitest';
import {
  applyAccepted,
  confidenceFor,
  groupByArea,
  parseReadiness,
  ReadinessFinding,
  verdictFor,
} from './readiness';

const report = (findings: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, summary: 'A shop', findings, ...extra });

const finding = (over: Partial<ReadinessFinding> = {}): ReadinessFinding => ({
  id: 'f1',
  title: 'Demo login still works',
  detail: 'Anyone can sign in.',
  fix: 'Delete the demo account.',
  severity: 'blocker',
  area: 'access',
  fixableBy: 'you',
  evidence: ['mvpfy.yml:demo_login'],
  accepted: false,
  ...over,
});

describe('parseReadiness', () => {
  it('parses findings and sorts them worst first', () => {
    const parsed = parseReadiness(
      report([
        { id: 'a', title: 'No error tracking', severity: 'note', area: 'operations' },
        { id: 'b', title: 'Payments are fake', severity: 'blocker', area: 'money' },
        { id: 'c', title: 'No backups', severity: 'risk', area: 'data' },
      ])
    );
    expect(parsed?.findings.map((f) => f.id)).toEqual(['b', 'c', 'a']);
    expect(parsed?.summary).toBe('A shop');
  });

  it('defaults an unknown severity to risk and an unknown area to operations', () => {
    const parsed = parseReadiness(report([{ title: 'Odd', severity: 'critical', area: 'vibes' }]));
    expect(parsed?.findings[0]).toMatchObject({ severity: 'risk', area: 'operations' });
  });

  it('only trusts an explicit mvpfy claim for who can fix it', () => {
    const parsed = parseReadiness(
      report([
        { id: 'a', title: 'Debug mode is on', fixableBy: 'mvpfy' },
        { id: 'b', title: 'Payments are fake', fixableBy: 'you' },
        { id: 'c', title: 'No backups' },
        { id: 'd', title: 'Odd', fixableBy: 'someone-else' },
      ])
    );
    expect(parsed?.findings.map((f) => f.fixableBy)).toEqual(['mvpfy', 'you', 'you', 'you']);
  });

  it('refuses to let badly organised code be called a launch blocker', () => {
    const parsed = parseReadiness(
      report([
        {
          id: 'a',
          title: 'Logic lives in the checkout screen',
          area: 'structure',
          severity: 'blocker',
        },
        { id: 'b', title: 'Orders are untyped blobs', area: 'model', severity: 'blocker' },
        {
          id: 'c',
          title: 'A live Stripe key is in the source',
          area: 'secrets',
          severity: 'blocker',
        },
      ])
    );
    const bySeverity = Object.fromEntries(parsed!.findings.map((f) => [f.id, f.severity]));
    expect(bySeverity).toEqual({ a: 'risk', b: 'risk', c: 'blocker' });
  });

  it('leaves a code-health finding alone when it is not overclaimed', () => {
    const parsed = parseReadiness(
      report([{ id: 'a', title: 'One enormous file', area: 'structure', severity: 'note' }])
    );
    expect(parsed?.findings[0].severity).toBe('note');
  });

  it('never lets the agent pre-accept its own finding', () => {
    const parsed = parseReadiness(report([{ id: 'a', title: 'Fake payments', accepted: true }]));
    expect(parsed?.findings[0].accepted).toBe(false);
  });

  it('returns null for junk and for a report with neither summary nor findings', () => {
    expect(parseReadiness(null)).toBeNull();
    expect(parseReadiness('nope')).toBeNull();
    expect(parseReadiness(JSON.stringify({ version: 1, findings: [] }))).toBeNull();
  });

  it('keeps a clean report with a summary and no findings', () => {
    expect(parseReadiness(report([]))?.findings).toEqual([]);
  });
});

describe('verdictFor', () => {
  it('is not ready while any blocker is open', () => {
    const v = verdictFor([finding(), finding({ id: 'f2', severity: 'risk' })]);
    expect(v.kind).toBe('not-ready');
    expect(v.blockers).toBe(1);
    expect(v.risks).toBe(1);
  });

  it('counts an accepted blocker separately and stops blocking on it', () => {
    const v = verdictFor([finding({ accepted: true })]);
    expect(v.kind).toBe('your-call');
    expect(v.blockers).toBe(0);
    expect(v.accepted).toBe(1);
    expect(v.acceptedBlockers).toBe(1);
    expect(v.detail).toContain('That risk is still there');
  });

  it('counts an accepted risk too, without calling it a blocker', () => {
    const v = verdictFor([finding({ severity: 'risk', accepted: true })]);
    expect(v).toMatchObject({ kind: 'your-call', accepted: 1, acceptedBlockers: 0, risks: 0 });
  });

  it('is your-call with risks only, and ready with nothing left', () => {
    expect(verdictFor([finding({ severity: 'risk' })]).kind).toBe('your-call');
    expect(verdictFor([finding({ severity: 'note' })]).kind).toBe('ready');
    expect(verdictFor([]).kind).toBe('ready');
  });
});

describe('confidenceFor', () => {
  const health = (over: Partial<ReadinessFinding>) =>
    finding({ severity: 'note', area: 'structure', ...over });

  it('is solid when nothing about the code is outstanding', () => {
    // Launch-safety findings say nothing about how well it will hold up.
    expect(confidenceFor([finding({ area: 'money', severity: 'blocker' })])).toMatchObject({
      level: 'solid',
      count: 0,
    });
    expect(confidenceFor([]).level).toBe('solid');
  });

  it('is workable with a couple of small things', () => {
    const c = confidenceFor([health({ id: 'a' }), health({ id: 'b', area: 'model' })]);
    expect(c).toMatchObject({ level: 'workable', count: 2 });
  });

  it('is fragile once the real problems pile up', () => {
    const risks = ['a', 'b', 'c'].map((id) => health({ id, severity: 'risk' }));
    expect(confidenceFor(risks)).toMatchObject({ level: 'fragile', count: 3 });
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => health({ id }));
    expect(confidenceFor(many).level).toBe('fragile');
  });

  it('counts how it will run, not just how it is written', () => {
    expect(confidenceFor([health({ area: 'operations' })]).count).toBe(1);
  });

  it('does not nag about something already weighed and accepted', () => {
    const c = confidenceFor([health({ severity: 'risk', accepted: true })]);
    expect(c).toMatchObject({ level: 'solid', count: 0 });
  });
});

describe('applyAccepted', () => {
  it('marks only the ids the builder accepted', () => {
    const parsed = parseReadiness(
      report([
        { id: 'a', title: 'Fake payments', severity: 'blocker' },
        { id: 'b', title: 'No backups', severity: 'risk' },
      ])
    );
    const applied = applyAccepted(parsed, ['a']);
    expect(applied.map((f) => f.accepted)).toEqual([true, false]);
    expect(applyAccepted(null, ['a'])).toEqual([]);
  });
});

describe('groupByArea', () => {
  it('groups findings and puts the area with the worst finding first', () => {
    const groups = groupByArea([
      finding({ id: 'a', severity: 'note', area: 'operations' }),
      finding({ id: 'b', severity: 'risk', area: 'data' }),
      finding({ id: 'c', severity: 'blocker', area: 'access' }),
      finding({ id: 'd', severity: 'note', area: 'data' }),
    ]);
    expect(groups.map((g) => g.area)).toEqual(['access', 'data', 'operations']);
    expect(groups[1].findings.map((f) => f.id)).toEqual(['b', 'd']);
  });
});
