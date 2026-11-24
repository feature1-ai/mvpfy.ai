/**
 * Which component libraries a product is already built with.
 *
 * An agent given a feature and no word about this reaches for whatever it
 * knows best, and the product ends up with two button components. The
 * product's own manifests already say what it uses, so mvpfy reads them,
 * shows the product manager what it found, and tells the agent to build with
 * that rather than beside it.
 *
 * Read from evidence only: a dependency in a `package.json`, or the file a
 * tool leaves behind. Nothing is inferred from how the code looks.
 *
 * To recognise another library, add an entry to `KNOWN`. Nothing else here
 * needs to change.
 */

export type LibraryKind =
  /** Ready-made components: what a feature's interface should be built from. */
  | 'components'
  /** Behaviour without appearance. Usually underneath the product's own components. */
  | 'primitives'
  /** How things are styled, which decides how new styles are written. */
  | 'styling'
  /** Where the product's own components are catalogued. */
  | 'catalogue';

interface KnownLibrary {
  name: string;
  kind: LibraryKind;
  /** Exact package names, or a scope ending in `/` to match everything under it. */
  packages: string[];
}

const KNOWN: KnownLibrary[] = [
  { name: 'MUI', kind: 'components', packages: ['@mui/material', '@material-ui/core'] },
  { name: 'Ant Design', kind: 'components', packages: ['antd', 'ant-design-vue'] },
  { name: 'Chakra UI', kind: 'components', packages: ['@chakra-ui/react'] },
  { name: 'Mantine', kind: 'components', packages: ['@mantine/core'] },
  { name: 'HeroUI', kind: 'components', packages: ['@heroui/react', '@nextui-org/react'] },
  { name: 'Fluent UI', kind: 'components', packages: ['@fluentui/react-components'] },
  { name: 'Carbon', kind: 'components', packages: ['@carbon/react'] },
  { name: 'React Bootstrap', kind: 'components', packages: ['react-bootstrap'] },
  { name: 'PrimeReact', kind: 'components', packages: ['primereact'] },
  { name: 'PrimeVue', kind: 'components', packages: ['primevue'] },
  { name: 'Vuetify', kind: 'components', packages: ['vuetify'] },
  { name: 'Element Plus', kind: 'components', packages: ['element-plus'] },
  { name: 'Quasar', kind: 'components', packages: ['quasar'] },
  { name: 'Naive UI', kind: 'components', packages: ['naive-ui'] },
  { name: 'Angular Material', kind: 'components', packages: ['@angular/material'] },
  { name: 'Flowbite', kind: 'components', packages: ['flowbite-react', 'flowbite'] },
  { name: 'daisyUI', kind: 'components', packages: ['daisyui'] },
  { name: 'React Native Paper', kind: 'components', packages: ['react-native-paper'] },
  { name: 'Tamagui', kind: 'components', packages: ['tamagui'] },
  { name: 'Radix UI', kind: 'primitives', packages: ['radix-ui', '@radix-ui/'] },
  { name: 'Headless UI', kind: 'primitives', packages: ['@headlessui/react', '@headlessui/vue'] },
  { name: 'React Aria', kind: 'primitives', packages: ['react-aria-components', 'react-aria'] },
  { name: 'Base UI', kind: 'primitives', packages: ['@base-ui-components/react'] },
  { name: 'Ark UI', kind: 'primitives', packages: ['@ark-ui/react', '@ark-ui/vue'] },
  { name: 'Tailwind CSS', kind: 'styling', packages: ['tailwindcss'] },
  { name: 'Bootstrap', kind: 'styling', packages: ['bootstrap'] },
  { name: 'styled-components', kind: 'styling', packages: ['styled-components'] },
  { name: 'Emotion', kind: 'styling', packages: ['@emotion/react'] },
  { name: 'NativeWind', kind: 'styling', packages: ['nativewind'] },
  { name: 'Storybook', kind: 'catalogue', packages: ['storybook', '@storybook/'] },
];

/** shadcn/ui is copied into the repository, so its trace is a file, not a dependency. */
export const SHADCN_CONFIG = 'components.json';

/**
 * Folders, inside one repository, where an interface's manifest tends to be.
 * A fixed list because the window may read named files and may not list
 * directories. A product laid out some other way is simply not detected.
 */
export const MANIFEST_FOLDERS = [
  '',
  'frontend',
  'client',
  'web',
  'app',
  'ui',
  'apps/web',
  'apps/app',
  'packages/ui',
];

export interface ComponentLibrary {
  name: string;
  kind: LibraryKind;
  /** As the manifest states it, range and all. Absent for a library found by its file. */
  version?: string;
  /** The file that says so, relative to the workspace. */
  source: string;
}

/** A file mvpfy read while looking: its path in the workspace, and what it holds. */
export interface ManifestFile {
  path: string;
  content: string;
}

/** Every file worth reading in a repository, given its folder inside the workspace. */
export function manifestCandidates(repoFolder: string): string[] {
  const base = repoFolder.replace(/^\.?\/+|\/+$/g, '');
  const join = (...parts: string[]) => parts.filter(Boolean).join('/');
  return MANIFEST_FOLDERS.flatMap((folder) => [
    join(base, folder, 'package.json'),
    join(base, folder, SHADCN_CONFIG),
  ]);
}

function dependenciesOf(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const block = parsed[field];
      if (!block || typeof block !== 'object') continue;
      for (const [name, version] of Object.entries(block)) {
        if (typeof version === 'string' && !(name in out)) out[name] = version;
      }
    }
    return out;
  } catch {
    // A manifest that does not parse says nothing, which is not the same as
    // saying the product uses no library.
    return {};
  }
}

function matchIn(deps: Record<string, string>, library: KnownLibrary): string | null {
  for (const wanted of library.packages) {
    const found = wanted.endsWith('/')
      ? Object.keys(deps)
          .filter((name) => name.startsWith(wanted))
          .sort()[0]
      : wanted in deps
        ? wanted
        : undefined;
    if (found) return deps[found];
  }
  return null;
}

/** Looks like a shadcn/ui config rather than some other tool's `components.json`. */
function isShadcnConfig(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return 'aliases' in parsed || String(parsed.$schema ?? '').includes('shadcn');
  } catch {
    return false;
  }
}

const KIND_ORDER: LibraryKind[] = ['components', 'primitives', 'styling', 'catalogue'];

/**
 * What the files say. Each library once, from the first file that names it,
 * with the ones a feature is built from ahead of what sits beneath them.
 */
export function detectComponentLibraries(files: ManifestFile[]): ComponentLibrary[] {
  const found = new Map<string, ComponentLibrary>();
  for (const file of files) {
    if (file.path.endsWith(SHADCN_CONFIG)) {
      if (isShadcnConfig(file.content) && !found.has('shadcn/ui')) {
        found.set('shadcn/ui', { name: 'shadcn/ui', kind: 'components', source: file.path });
      }
      continue;
    }
    const deps = dependenciesOf(file.content);
    for (const library of KNOWN) {
      if (found.has(library.name)) continue;
      const version = matchIn(deps, library);
      if (version === null) continue;
      found.set(library.name, {
        name: library.name,
        kind: library.kind,
        version,
        source: file.path,
      });
    }
  }
  return [...found.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name)
  );
}

const KIND_LABEL: Record<LibraryKind, string> = {
  components: 'components',
  primitives: 'unstyled primitives',
  styling: 'styling',
  catalogue: 'component catalogue',
};

/** One library as a line a person or an agent can read. */
export function describeLibrary(library: ComponentLibrary): string {
  const version = library.version ? ` ${library.version}` : '';
  return `${library.name}${version} — ${KIND_LABEL[library.kind]} (${library.source})`;
}

/**
 * What an agent building an interface is told about them. Empty when nothing
 * was found: silence is better than an instruction built on a guess.
 */
export function componentLibrariesBlock(libraries: ComponentLibrary[]): string {
  if (libraries.length === 0) return '';
  return [
    'This product already builds its interface with the following. mvpfy read them from the',
    "product's own files:",
    ...libraries.map((library) => `   • ${describeLibrary(library)}`),
    '',
    'Build any interface for this feature from these. Before writing a component, look for',
    "the one the product already has — its own first, then the library's. Do not add another",
    'component library or styling system, and do not hand-write what one of these already',
    'provides. If this feature truly needs something none of them offers, build it the way',
    'the existing components are built and say so in your summary.',
  ].join('\n');
}
