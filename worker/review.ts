import * as fs from 'node:fs';
import { AcceptanceCriterion, Snapshot } from '../shared/runner/contract';

/**
 * What a finished build changed, and what a person should try on its test
 * link — written for whoever reviews it, from Feature1's plan and the diff.
 *
 * The plan says what was asked for; the diff says what was done. Neither on
 * its own tells a product manager what to click: the stories are written
 * before the code, and a 6,000-line diff is not a test plan. So once a build
 * is ready, the agent reads both, read-only, and writes it down: the changes
 * by area, a numbered list of things to try, each traced to the story it
 * proves, what cannot be tried on a test link, and where the plan itself was
 * thin — a story with no acceptance criteria, two stories that say the same.
 *
 * Best effort. A build is ready whether or not this is written; a review that
 * fails is said so, and nothing else changes.
 */

export interface ReviewChange {
  area: string;
  what: string;
}

export interface ReviewTest {
  /** The story this proves, by code, when it proves one. */
  story: string | null;
  title: string;
  /** Where to start, as a path on the test link, when there is one. */
  where: string | null;
  steps: string[];
  expect: string;
}

export interface Review {
  summary: string;
  changes: ReviewChange[];
  tests: ReviewTest[];
  /** What the test link cannot show, and why. */
  notOnLink: string[];
  /** Where the plan was thin or contradicted itself. */
  planGaps: string[];
}

/** What the review prompt needs to know of each repository. */
export interface ReviewRepository {
  /** The folder it is in, relative to where the agent starts; '.' for one repository. */
  folder: string;
  base: string;
  /** Whether this build changed it. */
  changed: boolean;
}

const LIMITS = { text: 600, list: 30, steps: 12 };

/** What was asked for: the feature and its stories, as the execution's snapshot holds them. */
export interface ReviewPlan {
  code: string | null;
  title: string;
  description: string;
  stories: Array<{
    code: string | null;
    title: string;
    description: string;
    acceptanceCriteria: AcceptanceCriterion[];
  }>;
}

/** The plan out of an execution's snapshot: what the build itself was given. */
export function planOf(snapshot: Snapshot): ReviewPlan {
  const one = (s: Snapshot) => ({
    code: s.code ?? null,
    title: s.title ?? '',
    description: s.description ?? '',
    acceptanceCriteria: s.acceptanceCriteria ?? [],
  });
  return {
    ...one(snapshot),
    stories: (snapshot.stories?.length ? snapshot.stories : [snapshot]).map(one),
  };
}

function criteriaOf(story: ReviewPlan['stories'][number]): string[] {
  return story.acceptanceCriteria
    .map((c) => {
      const row = c as unknown as Record<string, unknown>;
      return String(row.text ?? row.description ?? row.criterion ?? row.title ?? '').trim();
    })
    .filter(Boolean);
}

export function reviewPrompt(
  feature: ReviewPlan,
  repositories: ReviewRepository[],
  outFile: string,
  linkSettings: string[] = []
): string {
  const stories = feature.stories
    .map((story) => {
      const criteria = criteriaOf(story);
      return [
        `### ${story.code ?? '(no code)'} — ${story.title}`,
        story.description.trim() || '(no description)',
        criteria.length
          ? `Acceptance criteria:\n${criteria.map((c) => `- ${c}`).join('\n')}`
          : 'Acceptance criteria: NONE were recorded for this story.',
      ].join('\n');
    })
    .join('\n\n');
  const changed = repositories.filter((r) => r.changed);
  const diffs = changed
    .map(
      (r) =>
        `- ${r.folder}: \`git -C ${r.folder} diff --stat origin/${r.base}...HEAD\`, then ` +
        `\`git -C ${r.folder} diff origin/${r.base}...HEAD -- <paths>\` for what you need`
    )
    .join('\n');
  return `You are reviewing a finished build so that a product manager knows what changed and what to try on its test link. You are READ-ONLY: do not edit, create, delete, commit or push anything, except the one file named at the end.

# What was asked for (from Feature1)

Feature ${feature.code ?? ''} — ${feature.title}
${feature.description.trim()}

${stories}

# What was done

The build's changes are committed on the current branch. Read them with:
${diffs || '- (no repository was changed)'}
Read the changed files themselves where the diff alone does not show what a person would see. Look for the pages, routes, buttons and settings a person meets.
${linkSettings.length ? `\nThe test link starts with these settings, which the build asked for: ${linkSettings.join(', ')}. Use them: say which test each one makes possible.\n` : ''}
# What to write

Write ONE JSON file at ${outFile}, and nothing else, shaped exactly:

{
  "summary": "two or three plain sentences: what this feature now does, for a product manager",
  "changes": [{ "area": "who or what it affects, e.g. 'Admin: safety page'", "what": "what changed there, plainly" }],
  "tests": [{
    "story": "the story code this proves, or null",
    "title": "short name of the check",
    "where": "the path to open on the test link, e.g. '/admin/operations', or null",
    "steps": ["each thing to do, in order, as a person would do it in the browser"],
    "expect": "what they should see if it works"
  }],
  "notOnLink": ["anything that cannot be tried on a test link, and why (e.g. a third-party sign-in it has no keys for)"],
  "planGaps": ["where the plan was thin: stories with no acceptance criteria, stories that repeat each other, criteria the code does not meet"]
}

Rules:
- Write for a product manager, not a developer: say what they will see and do, not function names.
- Every story should have at least one test. Where a story had acceptance criteria, cover each one and quote it in the title.
- Only describe what the code really does. If you are not sure something works on a test link, put it in notOnLink rather than in tests.
- 4 to 15 tests, most important first. Keep every string under ${LIMITS.text} characters.
- Do not include secrets, tokens or passwords other than a demo login the product already documents.
`;
}

const str = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, LIMITS.text) : '';

const strings = (value: unknown, max = LIMITS.list): string[] =>
  Array.isArray(value) ? value.map(str).filter(Boolean).slice(0, max) : [];

/** The agent's file, checked and cut to size; null when it is not a review. */
export function parseReview(text: string): Review | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, '').trim());
  } catch {
    // An agent may wrap the JSON in a code fence; take what is inside.
    const fenced = text.match(/\{[\s\S]*\}/);
    if (!fenced) return null;
    try {
      raw = JSON.parse(fenced[0]);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const changes = (Array.isArray(row.changes) ? row.changes : [])
    .map((c) => ({ area: str((c as ReviewChange)?.area), what: str((c as ReviewChange)?.what) }))
    .filter((c) => c.area && c.what)
    .slice(0, LIMITS.list);
  const tests = (Array.isArray(row.tests) ? row.tests : [])
    .map((t) => {
      const test = (t ?? {}) as Record<string, unknown>;
      const story = str(test.story);
      const where = str(test.where);
      return {
        story: story && story.toLowerCase() !== 'null' ? story : null,
        title: str(test.title),
        where: where && where.toLowerCase() !== 'null' ? where : null,
        steps: strings(test.steps, LIMITS.steps),
        expect: str(test.expect),
      };
    })
    .filter((t) => t.title && (t.steps.length > 0 || t.expect))
    .slice(0, LIMITS.list);
  const summary = str(row.summary);
  if (!summary && changes.length === 0 && tests.length === 0) return null;
  return {
    summary,
    changes,
    tests,
    notOnLink: strings(row.notOnLink),
    planGaps: strings(row.planGaps),
  };
}

/** Read what the agent wrote; null when it wrote nothing usable. */
export function readReview(file: string): Review | null {
  try {
    return parseReview(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** One line, for mvpfy-cloud to read off the log. */
export function reviewLine(review: Review): string {
  return `REVIEW ${JSON.stringify(review)}`;
}
