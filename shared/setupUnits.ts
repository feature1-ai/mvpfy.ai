import type { AgentUnit, UnitCheckSpec } from './agentUnits';
import { BOOTSTRAP_FILE, configDirFor, Project } from './types';

/**
 * Setting a product up, as six steps instead of one.
 *
 * It used to be a single agent run holding everything at once — containers,
 * stand-ins, env files, the manifest, the database, the seed, the demo login,
 * the notes — with one way to retry it: all of it, again. Each step here is
 * its own run, checked by mvpfy when it finishes, and sent back with exactly
 * what was missing when the check does not hold (shared/unitRunner.ts).
 *
 * The seams are where something can be looked at afterwards, because a step
 * nobody can check is only a pause:
 *
 *   1. containers  — the stack file exists;
 *   2. environment — the env files exist, and Docker accepts the whole stack;
 *   3. manifest    — it names one port, the same one twice;
 *   4. database    — the stack still holds, and the migrations are declared;
 *   5. demo login  — the login mvpfy will show is the one the seed creates;
 *   6. handover    — the notes for the product manager and for other agents exist.
 *
 * The steps share one agent conversation (electron/services/agentUnits.ts).
 * That is what makes seams this fine affordable: the product is read once,
 * and the run writing the env files is the one that chose the services they
 * point at. So each step has two briefs. The full one opens a conversation,
 * or replaces one that was lost, and carries the complete setup instructions
 * — those rules were each written after something went wrong, and most bind
 * more than one step. The short one is for an agent already in the
 * conversation, and says only which part is this run's.
 *
 * Whether the app actually comes up, and whether the seed actually runs, is
 * not checked here. mvpfy already does both itself once setup hands over —
 * it starts the stack, waits for the app to answer, then runs the seed — and
 * that is the only place those questions can be answered honestly.
 */

interface StepPlan {
  /** Never renamed: a retry finds its place by it. */
  id: string;
  /** For the product manager: it is what the run's log calls this step. */
  title: string;
  /** What this run does. */
  scope: string[];
  /** What it must leave for a later step, so it stops where it should. */
  later: string[];
  checks: UnitCheckSpec[];
}

const NOTES = 'AGENTS.md, CLAUDE.md, .gitignore, mvpfy-summary.md and mvpfy-run.md';

function plan(project: Pick<Project, 'mode'>): StepPlan[] {
  const linked = project.mode === 'linked';
  const cfg = configDirFor(project.mode);
  const compose = `${cfg}docker-compose.mvpfy.yml`;
  const manifest = `${cfg}mvpfy.yml`;
  const envExample = `${cfg}.env.mvpfy.example`;
  const env = `${cfg}.env`;

  return [
    {
      id: 'containers',
      title: 'Give every part of your product a container',
      scope: [
        'Steps 1 to 5 of the instructions: read the workspace, honour the components list and the',
        'answers file, and work out everything the product depends on.',
        `From step 6, write a Dockerfile for any repository that needs one, and ${compose}: every`,
        'part of the product, and a service or stand-in for every dependency that is missing.',
        'Every rule about development mode, ports, watchers, health checks, images and build',
        'caches applies to this step, including proving the start command in the image.',
        'Refer to the env file from the stack as the rules say, and use variable names freely —',
        'the next step writes the files and fills in the values.',
      ],
      later: [
        `the env files, ${envExample} and ${env}`,
        'mvpfy.yml',
        'database initialisation, migrations, sample data and the demo login',
        NOTES,
      ],
      checks: [{ kind: 'files', paths: [compose] }],
    },
    {
      id: 'environment',
      title: 'Fill in the settings your product needs',
      scope: [
        `From step 6, write the env files: ${envExample} with a safe local default for every`,
        `variable the product needs, and ${env}, the live file, with the same keys and every value`,
        'filled in so the stack boots with exactly these values.',
        'Each variable goes in the file the app that reads it actually reads. Wire every',
        'service to its env file so the values really reach the containers.',
        `You may change ${compose} where a service needs a variable or an env file it does not`,
        'yet have. Do not restructure it.',
      ],
      later: [
        'mvpfy.yml',
        'the MVPFY_DEMO_EMAIL and MVPFY_DEMO_PASSWORD entries, which the demo login step adds',
        'database initialisation, migrations and sample data',
        NOTES,
      ],
      checks: [
        { kind: 'files', paths: [envExample, env] },
        { kind: 'compose-config', linked },
      ],
    },
    {
      id: 'manifest',
      title: 'Tell mvpfy where your app is',
      scope: [
        `From step 6, write ${manifest}: the app's name, its main service, the host port, every`,
        'service with its port, and the health-check URL.',
        `Read ${compose} for the ports — what it publishes is the truth. \`host_port\` and the`,
        'port inside `url` must be that same port.',
        'Record tenancy, any component that runs elsewhere, and the mobile block where the',
        'instructions call for them.',
        `Do not change ${compose} or the env files unless one of them contradicts the other.`,
      ],
      later: [
        'the `migrations:` list, which the database step adds',
        'the `seed_command`, `demo_login` and `demo_credentials` entries',
        NOTES,
      ],
      checks: [
        { kind: 'files', paths: [manifest] },
        { kind: 'manifest-ports', path: manifest },
      ],
    },
    {
      id: 'database',
      title: 'Give your app its database',
      scope: [
        'Everything the instructions say about the database itself: a named volume for each one,',
        'a fresh database initialised from the committed schema rather than by replaying old',
        'migrations, and the database address set explicitly on the app service.',
        `Record pending migrations in ${manifest} as the top-level \`migrations:\` list, in the form`,
        'the instructions give. Write `migrations: []` when the product needs none — the key is',
        'always there, so that its absence never has to be interpreted.',
        'Never drop, reset or recreate a database that already holds data.',
      ],
      later: ['sample data and the demo login', NOTES],
      checks: [
        { kind: 'compose-config', linked },
        { kind: 'manifest-ports', path: manifest },
        { kind: 'contains', path: manifest, needles: ['migrations:'] },
      ],
    },
    {
      id: 'demo-login',
      title: 'Add sample data and a demo login',
      scope: [
        'Everything the instructions say about seeding: a seed that runs as part of the stack',
        'STARTING UP, is idempotent, and never overwrites data that is already there.',
        'If the app has a sign-in, a demo account: its email and password taken from the env',
        `files as MVPFY_DEMO_EMAIL and MVPFY_DEMO_PASSWORD (add them to ${envExample} and ${env}),`,
        `and recorded in ${manifest} as \`demo_login:\` with the values the seed really uses.`,
        `Record \`seed_command:\` in ${manifest} when the product needs seeding, and`,
        '`demo_credentials:` for any further logins. Where tenancy applies, the demo customer',
        'you seed is the one the tenancy rule names.',
        'If the product needs no seeding and has no sign-in, say so in your last message and',
        'change nothing.',
      ],
      later: [NOTES],
      checks: [
        { kind: 'compose-config', linked },
        { kind: 'manifest-ports', path: manifest },
        { kind: 'demo-login', manifest, env },
      ],
    },
    {
      id: 'handover',
      title: 'Write down what was set up',
      scope: [
        'The rest of step 6 and the closing instructions: the mvpfy block in AGENTS.md, the',
        `CLAUDE.md pointer to it, the .gitignore entries, ${cfg}mvpfy-summary.md for the product`,
        `manager, and ${cfg}mvpfy-run.md.`,
        'Describe what the earlier steps actually built — read the files, do not assume — and',
        'name every stand-in and what the product would need in its place.',
        'Change nothing else. If you find something wrong in what the earlier steps wrote, say',
        'so in mvpfy-run.md rather than rewriting it here.',
      ],
      later: [],
      checks: [
        { kind: 'files', paths: [`${cfg}mvpfy-summary.md`, `${cfg}mvpfy-run.md`] },
        {
          kind: 'contains',
          path: 'AGENTS.md',
          needles: ['<!-- mvpfy:start', '<!-- mvpfy:end -->'],
        },
        // Not a `contains` of "@AGENTS.md": the prompt tells the agent to
        // leave an existing import entirely alone, so a repository that
        // already wrote it as @./AGENTS.md would fail a step it had satisfied
        // — three attempts, then "Setup stopped at step 6 of 6" over a
        // CLAUDE.md that was correct before mvpfy arrived.
        { kind: 'imports', path: 'CLAUDE.md', target: 'AGENTS.md' },
      ],
    },
  ];
}

/** What every brief says about this step, whichever conversation it lands in. */
function stepBody(
  step: StepPlan,
  index: number,
  steps: StepPlan[],
  bootstrapFile: string,
  where: 'below' | 'earlier'
): string[] {
  const earlier = steps.slice(0, index).map((s) => s.title);
  const instructions =
    where === 'below' ? 'the instructions below tell' : 'the setup instructions told';
  return [
    ...step.scope.map((line) => `  ${line}`),
    '',
    earlier.length > 0
      ? 'Earlier runs have already done the following. Read what they wrote and build on it; do\n' +
        `not redo it:\n${earlier.map((title) => `  • ${title}`).join('\n')}\n` +
        'What those runs wrote is this same setup, still in progress. Change it in place where\n' +
        'this step needs to: the rule about .bak backups protects files that were here before\n' +
        'setup began, not these.'
      : 'This is the first step. Nothing has been set up yet.',
    '',
    step.later.length > 0
      ? 'Leave these for the runs that come after this one. Do NOT write them now, even where\n' +
        `${instructions} you to:\n${step.later.map((item) => `  • ${item}`).join('\n')}`
      : 'This is the last step. Nothing is left for a later run.',
    '',
    `In ${bootstrapFile}, move only the cards whose work this run does. A card that needs a later`,
    'step as well stays in "doing" — the run that finishes it marks it done.',
    'When this step is finished, stop. If only the product manager can unblock you, write your',
    'questions as the setup instructions describe and stop there.',
  ];
}

/** The note in front of the full instructions: which part is this run's. */
function fullBrief(
  step: StepPlan,
  index: number,
  steps: StepPlan[],
  bootstrapFile: string,
  instructions: string
): string {
  return [
    `THIS RUN IS STEP ${index + 1} OF ${steps.length} OF SETUP: ${step.title.toUpperCase()}.`,
    '',
    `Setting this product up is done in ${steps.length} separate runs. When each finishes, mvpfy checks`,
    'what it left behind before starting the next, and sends it back if the check does not hold.',
    'The complete instructions for the whole setup follow this note, so that you can see where',
    'this step fits and which rules bind it. In THIS run, do only this:',
    '',
    ...stepBody(step, index, steps, bootstrapFile, 'below'),
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    '',
    instructions,
  ].join('\n');
}

/**
 * The brief for an agent already in the conversation.
 *
 * The earlier turns are still in view — the complete instructions, and every
 * "leave that for a later run" the steps before this one were given. So the
 * job of this note is to say which of those still stand: the instructions
 * do, in full; the earlier step notes do not, and this one replaces them.
 */
function resumeBrief(
  step: StepPlan,
  index: number,
  steps: StepPlan[],
  bootstrapFile: string
): string {
  return [
    `THIS RUN IS STEP ${index + 1} OF ${steps.length} OF SETUP: ${step.title.toUpperCase()}.`,
    '',
    'This continues our conversation about setting this product up, so you already know the',
    'code and the decisions made so far; use that rather than reading everything again. The',
    'complete setup instructions from the start of this conversation still apply in full.',
    'What changes is which part is this run’s: this note REPLACES the step note of every',
    'earlier run, so something an earlier run was told to leave for later is yours now if it',
    'is listed here. mvpfy checked the earlier steps and they held, but the files on disk may',
    'have changed since — check anything you are about to rely on. In THIS run, do only this:',
    '',
    ...stepBody(step, index, steps, bootstrapFile, 'earlier'),
  ].join('\n');
}

/**
 * The steps of setup for this project, each briefed and each with the
 * evidence mvpfy will look for.
 *
 * `instructions` is the complete setup prompt, already filled in for the
 * project, so this stays about how the work is divided and nothing else.
 */
export function buildSetupUnits(project: Pick<Project, 'mode'>, instructions: string): AgentUnit[] {
  const steps = plan(project);
  const bootstrapFile = configDirFor(project.mode) + BOOTSTRAP_FILE;
  return steps.map((step, index) => ({
    id: step.id,
    title: step.title,
    promptText: fullBrief(step, index, steps, bootstrapFile, instructions),
    resumeText: resumeBrief(step, index, steps, bootstrapFile),
    checks: step.checks,
  }));
}

/** Tries each step of setup gets: the first, then two with the failed check in hand. */
export const SETUP_UNIT_ATTEMPTS = 3;
