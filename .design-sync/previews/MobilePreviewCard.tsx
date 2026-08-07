import { MobilePreviewCard } from 'mvpfy';

export const ExpoWithQr = () => (
  <MobilePreviewCard
    preview={{
      kind: 'expo',
      expoUrl: 'exp://192.168.1.24:8081',
      note: 'The web preview shows most screens; camera features need a real device.',
    }}
  />
);

export const NoteOnly = () => (
  <MobilePreviewCard
    preview={{
      kind: 'react-native',
      expoUrl: null,
      note: 'This bare React Native app needs a simulator: run "npx react-native run-ios" in the repo.',
    }}
  />
);
