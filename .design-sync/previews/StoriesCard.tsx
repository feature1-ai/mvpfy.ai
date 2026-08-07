import { StoriesCard } from 'mvpfy';

// StoriesCard reads a slice of the project controller; this mock provides
// exactly the fields it renders from, with realistic Feature1 story data.
const base = {
  project: {
    id: 'p1',
    localPath: '/Users/pm/.mvpfy/projects/ar-backend-stack',
    basePort: 4101,
    status: 'running',
    lastStoryId: null,
    generatedFiles: [],
    repos: [
      { url: 'https://github.com/inwisely/ar-backend', dir: '/ws/ar-backend' },
      { url: 'https://github.com/inwisely/ar-frontend', dir: '/ws/ar-frontend' },
    ],
  },
  targetRepoDir: '/ws/ar-backend',
  stories: [
    { id: 's-141', code: 'INW-141', title: 'Bulk-archive paid invoices', status: 'ready' },
    { id: 's-142', code: 'INW-142', title: 'Invoice reminder cadence settings', status: 'in progress' },
    { id: 's-143', code: 'INW-143', title: 'Export aging report as CSV', status: 'ready' },
  ],
  storiesError: null,
  loadingStories: false,
  tenantConnected: true,
  busy: false,
  lastShipPrUrl: null,
  implement: async () => {},
  refreshStories: async () => {},
  setTargetRepoDir: () => {},
  openExternal: () => {},
};

export const StoryList = () => <StoriesCard c={base as never} />;

export const WithPrReady = () => (
  <StoriesCard
    c={{ ...base, lastShipPrUrl: 'https://github.com/inwisely/ar-backend/pull/87' } as never}
  />
);

export const NotConnected = () => (
  <StoriesCard c={{ ...base, stories: [], tenantConnected: false } as never} />
);

export const LoadError = () => (
  <StoriesCard
    c={{ ...base, stories: [], storiesError: 'Feature1 MCP request failed (HTTP 401)' } as never}
  />
);
