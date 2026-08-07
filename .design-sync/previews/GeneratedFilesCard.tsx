import { GeneratedFilesCard } from 'mvpfy';

const mvpfyYml = [
  'app:',
  '  name: Acme Billing Portal',
  '  main_service: frontend',
  '  host_port: 4101',
  '  url: http://localhost:4101',
  '',
  'demo_login:',
  '  email: demo@example.com',
  '  password: DemoPass123!',
  '',
  'services:',
  '  - name: frontend',
  '    ports: ["4101:80"]',
  '  - name: db',
  '    image: postgres:15',
  '    volume: mvpfy_pgdata',
].join('\n');

const files = [
  { relativePath: 'mvpfy.yml', exists: true, content: mvpfyYml },
  { relativePath: 'Dockerfile', exists: true, content: 'FROM node:20-alpine\n…' },
  { relativePath: 'docker-compose.mvpfy.yml', exists: true, content: 'services:\n  …' },
  { relativePath: '.env.mvpfy.example', exists: true, content: 'DATABASE_URL=…' },
  { relativePath: 'mvpfy-run.md', exists: true, content: '# Running locally\n…' },
];

const base = {
  viewerFiles: files,
  activeFile: 'mvpfy.yml',
  activeFileContent: mvpfyYml,
  refreshFiles: () => {},
  setActiveFile: () => {},
};

export const WithGeneratedFiles = () => <GeneratedFilesCard c={base as never} />;

export const BeforeBootstrap = () => (
  <GeneratedFilesCard
    c={{ ...base, viewerFiles: [], activeFile: null, activeFileContent: '' } as never}
  />
);
