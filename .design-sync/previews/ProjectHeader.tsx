import { ProjectHeader } from 'mvpfy';

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
  appUrl: 'http://localhost:4101',
  appHealthy: true,
  confirmRemove: false,
  removing: false,
  openExternal: () => {},
  setConfirmRemove: () => {},
  removeProject: async () => {},
};

export const Healthy = () => <ProjectHeader c={base as never} />;

export const NotRespondingYet = () => (
  <ProjectHeader c={{ ...base, appHealthy: false } as never} />
);

export const ConfirmingRemoval = () => (
  <ProjectHeader c={{ ...base, confirmRemove: true } as never} />
);
