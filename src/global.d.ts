import type React from 'react';
import type { MvpfyApi } from '../shared/types';

declare global {
  interface Window {
    mvpfy: MvpfyApi;
  }

  namespace JSX {
    interface IntrinsicElements {
      /** Electron <webview> tag (enabled via webviewTag: true). */
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { src?: string; partition?: string },
        HTMLElement
      >;
    }
  }
}

declare module '*.txt?raw' {
  const content: string;
  export default content;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

export {};
