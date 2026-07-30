import type { MvpfyApi } from '../shared/types';

declare global {
  interface Window {
    mvpfy: MvpfyApi;
  }
}

declare module '*.txt?raw' {
  const content: string;
  export default content;
}

export {};
