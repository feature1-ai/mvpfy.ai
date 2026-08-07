import { EnvironmentCard } from 'mvpfy';

const base = {
  project: {
    id: 'p1',
    localPath: '/Users/pm/.mvpfy/projects/ar-backend-stack',
    basePort: 4101,
    status: 'running',
    lastStoryId: null,
    generatedFiles: ['mvpfy.yml'],
    repos: [{ url: 'https://github.com/inwisely/ar-backend', dir: '/ws/ar-backend' }],
  },
  busy: false,
  hasMvpfyYml: true,
  appHealthy: true,
  appUrl: 'http://localhost:4101',
  mobilePreview: null,
  demoCredentials: [],
  bootstrap: async () => {},
  docker: async () => {},
  openExternal: () => {},
};

export const RunningHealthy = () => (
  <EnvironmentCard
    c={
      {
        ...base,
        demoCredentials: [
          {
            label: 'App login',
            fields: [
              { key: 'email', value: 'demo@example.com' },
              { key: 'password', value: 'DemoPass123!' },
            ],
          },
        ],
      } as never
    }
  />
);

export const NeedsReview = () => (
  <EnvironmentCard
    c={{ ...base, project: { ...base.project, status: 'needs-review' }, appHealthy: false } as never}
  />
);

export const FreshClone = () => (
  <EnvironmentCard
    c={
      {
        ...base,
        project: { ...base.project, status: 'cloned', generatedFiles: [] },
        hasMvpfyYml: false,
        appHealthy: false,
      } as never
    }
  />
);

export const Starting = () => (
  <EnvironmentCard c={{ ...base, appHealthy: false } as never} />
);
