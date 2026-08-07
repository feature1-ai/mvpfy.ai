import { ProjectList } from 'mvpfy';

const state = {
  tenant: { slug: 'acme', host: 'acme-mcp.feature1.ai', tokenKeychainEntry: 'feature1-mcp-acme' },
  settings: { defaultAgent: 'claude' as const, codexModel: 'gpt-5.3-codex' },
  projects: [
    {
      id: 'p1',
      localPath: '/Users/pm/.mvpfy/projects/ar-backend-stack',
      basePort: 4101,
      status: 'running' as const,
      lastStoryId: 'INW-142',
      generatedFiles: ['mvpfy.yml'],
      repos: [
        { url: 'https://github.com/inwisely/ar-backend', dir: '/ws/ar-backend' },
        { url: 'https://github.com/inwisely/ar-frontend', dir: '/ws/ar-frontend' },
      ],
    },
    {
      id: 'p2',
      localPath: '/Users/pm/.mvpfy/projects/jarshare',
      basePort: 4100,
      status: 'cloned' as const,
      lastStoryId: null,
      generatedFiles: [],
      repos: [{ url: '/Users/pm/projects/jarshare', dir: '/ws/jarshare' }],
    },
    {
      id: 'p3',
      localPath: '/Users/pm/.mvpfy/projects/billing-portal',
      basePort: 4110,
      status: 'needs-review' as const,
      lastStoryId: null,
      generatedFiles: ['mvpfy.yml', 'Dockerfile'],
      repos: [{ url: 'https://github.com/acme/billing-portal', dir: '/ws/billing-portal' }],
    },
  ],
};

export const WithProjects = () => (
  <ProjectList
    state={state as never}
    selectedProjectId="p1"
    onSelect={() => {}}
    updateState={() => {}}
  />
);

export const Empty = () => (
  <ProjectList
    state={{ ...state, projects: [] } as never}
    selectedProjectId={null}
    onSelect={() => {}}
    updateState={() => {}}
  />
);
