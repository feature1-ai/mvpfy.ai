import { describe, expect, it } from 'vitest';
import { agentReply, appTargets, replySoFar, stripRestart, titleFrom } from './chat';
import type { ProductComponent } from './components';

const part = (
  p: Partial<ProductComponent> & Pick<ProductComponent, 'id' | 'kind'>
): ProductComponent => ({
  name: p.id,
  state: 'found',
  evidence: '',
  ...p,
});

const yml = `services:
  - name: web
    ports: ["4100:3000"]
  - name: admin
    ports: ["4101:3000"]
`;

describe('appTargets', () => {
  it('offers the whole project first, then each part someone looks at, on its own port', () => {
    const targets = appTargets(
      [
        part({ id: 'portal', name: 'Customer portal', kind: 'web', service: 'web', repo: 'web' }),
        part({ id: 'admin', kind: 'admin', service: 'admin' }),
        part({ id: 'api', kind: 'api', service: 'api' }),
        part({ id: 'db', kind: 'database' }),
      ],
      yml,
      'http://localhost:4100'
    );
    expect(targets.map((t) => t.id)).toEqual(['project', 'portal', 'admin']);
    expect(targets[1]).toMatchObject({ url: 'http://localhost:4100', repo: 'web', service: 'web' });
    expect(targets[2].url).toBe('http://localhost:4101');
  });

  it('shows the main app for the first web part with no service of its own, and only the first', () => {
    const targets = appTargets(
      [part({ id: 'a', kind: 'web' }), part({ id: 'b', kind: 'web' })],
      null,
      'http://localhost:4100'
    );
    expect(targets.find((t) => t.id === 'a')?.url).toBe('http://localhost:4100');
    expect(targets.find((t) => t.id === 'b')?.url).toBeNull();
  });

  it('leaves out what was skipped or lives elsewhere, and points a remote part at its address', () => {
    const targets = appTargets(
      [
        part({ id: 'skipped', kind: 'web', decision: 'skip' }),
        part({ id: 'gone', kind: 'web', state: 'missing' }),
        part({
          id: 'remote',
          kind: 'admin',
          state: 'missing',
          decision: 'remote',
          url: 'https://admin.example.com',
        }),
        part({ id: 'phone', kind: 'mobile' }),
      ],
      null,
      'http://localhost:4100'
    );
    expect(targets.map((t) => t.id)).toEqual(['project', 'remote', 'phone']);
    expect(targets.find((t) => t.id === 'remote')?.url).toBe('https://admin.example.com');
    expect(targets.find((t) => t.id === 'phone')?.url).toBeNull();
  });
});

describe('reading what the agent said', () => {
  it("takes claude's closing result as the answer, and its restart line off the end", () => {
    const log = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Looking at the button.' }] },
      }),
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'The checkout button is green now.\n\nRestart: no',
      }),
    ].join('\n');
    expect(agentReply(log)).toEqual({
      text: 'The checkout button is green now.',
      restart: false,
      error: null,
    });
  });

  it("takes codex's last message as the answer, since codex has no closing result", () => {
    const log = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Checking.' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'ls' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Added STRIPE_KEY.\nRestart: yes' },
      }),
    ].join('\n');
    expect(agentReply(log)).toEqual({ text: 'Added STRIPE_KEY.', restart: true, error: null });
  });

  it('says so when the agent failed', () => {
    const log = JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } });
    expect(agentReply(log).error).toBe('usage limit reached');
  });

  it('shows the latest thing said while the run is still going', () => {
    const log =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'First.' }] },
      }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Now editing.' }] },
      }) +
      '\n{"type":"assi';
    expect(replySoFar(log)).toBe('Now editing.');
    expect(replySoFar('')).toBeNull();
  });

  it('reads a restart line however it is dressed', () => {
    expect(stripRestart('Done.\n**Restart: Yes**')).toEqual({ text: 'Done.', restart: true });
    expect(stripRestart('No line here')).toEqual({ text: 'No line here', restart: false });
  });
});

describe('titleFrom', () => {
  it('names a conversation by its first line, kept short', () => {
    expect(titleFrom('Make the checkout button green\nand bigger')).toBe(
      'Make the checkout button green'
    );
    expect(titleFrom('x'.repeat(80))).toHaveLength(48);
    expect(titleFrom('   ')).toBe('New chat');
  });
});
