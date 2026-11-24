import { describe, expect, it } from 'vitest';
import {
  componentLibrariesBlock,
  describeLibrary,
  detectComponentLibraries,
  manifestCandidates,
} from './componentLibraries';

const pkg = (path: string, deps: Record<string, string>, dev: Record<string, string> = {}) => ({
  path,
  content: JSON.stringify({ dependencies: deps, devDependencies: dev }),
});

describe('manifestCandidates', () => {
  it('looks at the repository root and the usual interface folders', () => {
    const paths = manifestCandidates('');
    expect(paths).toContain('package.json');
    expect(paths).toContain('components.json');
    expect(paths).toContain('frontend/package.json');
    expect(paths).toContain('apps/web/components.json');
  });

  it('stays inside the repository it was given', () => {
    const paths = manifestCandidates('./shop-web/');
    expect(paths.every((p) => p.startsWith('shop-web/'))).toBe(true);
    expect(paths).toContain('shop-web/package.json');
    expect(paths).toContain('shop-web/packages/ui/package.json');
  });
});

describe('detectComponentLibraries', () => {
  it('finds a library by its dependency and keeps the version as written', () => {
    expect(detectComponentLibraries([pkg('package.json', { '@mui/material': '^5.15.0' })])).toEqual(
      [{ name: 'MUI', kind: 'components', version: '^5.15.0', source: 'package.json' }]
    );
  });

  it('reads development dependencies too', () => {
    const found = detectComponentLibraries([pkg('package.json', {}, { tailwindcss: '^3.4.1' })]);
    expect(found.map((l) => l.name)).toEqual(['Tailwind CSS']);
  });

  it('matches every package under a scope as one library', () => {
    const found = detectComponentLibraries([
      pkg('package.json', { '@radix-ui/react-dialog': '1.0.5', '@radix-ui/react-tabs': '1.0.4' }),
    ]);
    expect(found).toEqual([
      { name: 'Radix UI', kind: 'primitives', version: '1.0.5', source: 'package.json' },
    ]);
  });

  it('recognises shadcn/ui by the file it leaves behind', () => {
    const found = detectComponentLibraries([
      { path: 'web/components.json', content: '{"$schema":"https://ui.shadcn.com/schema.json"}' },
    ]);
    expect(found).toEqual([
      { name: 'shadcn/ui', kind: 'components', source: 'web/components.json' },
    ]);
  });

  it("does not take another tool's components.json for shadcn/ui", () => {
    expect(
      detectComponentLibraries([{ path: 'components.json', content: '{"items":[]}' }])
    ).toEqual([]);
  });

  it('puts what a feature is built from ahead of what sits beneath it', () => {
    const found = detectComponentLibraries([
      pkg(
        'package.json',
        { tailwindcss: '3', '@radix-ui/react-slot': '1', antd: '5' },
        { storybook: '8' }
      ),
    ]);
    expect(found.map((l) => l.name)).toEqual([
      'Ant Design',
      'Radix UI',
      'Tailwind CSS',
      'Storybook',
    ]);
  });

  it('names a library once, from the first file that has it', () => {
    const found = detectComponentLibraries([
      pkg('web/package.json', { antd: '5.1.0' }),
      pkg('admin/package.json', { antd: '4.0.0' }),
    ]);
    expect(found).toEqual([
      { name: 'Ant Design', kind: 'components', version: '5.1.0', source: 'web/package.json' },
    ]);
  });

  it('finds nothing in a manifest that does not parse, or that has no interface', () => {
    expect(detectComponentLibraries([{ path: 'package.json', content: '{ not json' }])).toEqual([]);
    expect(detectComponentLibraries([pkg('package.json', { express: '4' })])).toEqual([]);
    expect(detectComponentLibraries([{ path: 'package.json', content: 'null' }])).toEqual([]);
  });
});

describe('what the agent is told', () => {
  it('says nothing when nothing was found', () => {
    expect(componentLibrariesBlock([])).toBe('');
  });

  it('names each library with where mvpfy read it, and forbids adding another', () => {
    const libraries = detectComponentLibraries([
      pkg('web/package.json', { '@mantine/core': '7.2.0' }),
    ]);
    const block = componentLibrariesBlock(libraries);
    expect(block).toContain('Mantine 7.2.0 — components (web/package.json)');
    expect(block).toContain('Do not add another');
  });

  it('describes a library found by its file without inventing a version', () => {
    expect(
      describeLibrary({ name: 'shadcn/ui', kind: 'components', source: 'components.json' })
    ).toBe('shadcn/ui — components (components.json)');
  });
});
