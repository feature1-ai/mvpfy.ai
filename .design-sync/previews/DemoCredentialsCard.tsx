import { DemoCredentialsCard } from 'mvpfy';

const appLogin = {
  label: 'App login',
  fields: [
    { key: 'url', value: 'http://localhost:4101' },
    { key: 'email', value: 'demo@example.com' },
    { key: 'password', value: 'DemoPass123!' },
    { key: 'otp', value: 'read the one-time code at http://localhost:4103' },
  ],
};

const adminLogin = {
  label: 'Sidekiq dashboard',
  fields: [
    { key: 'url', value: 'http://localhost:4102/sidekiq' },
    { key: 'username', value: 'admin' },
    { key: 'password', value: 'admin' },
  ],
};

export const SingleLogin = () => (
  <DemoCredentialsCard credentials={[appLogin]} onOpenExternal={() => {}} />
);

export const MultipleLogins = () => (
  <DemoCredentialsCard credentials={[appLogin, adminLogin]} onOpenExternal={() => {}} />
);
