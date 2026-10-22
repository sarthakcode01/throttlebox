import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/**
 * Stoplight Elements renders the OpenAPI document through a custom element.
 * The tag is not part of React's known intrinsic elements, so it is declared
 * here rather than casting the JSX at every use site.
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'elements-api': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        apiDescriptionUrl?: string;
        apiDescription?: Record<string, unknown>;
        router?: string;
        layout?: string;
      };
    }
  }
}

export {};
