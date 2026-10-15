import type { ReactNode } from 'react';

/**
 * Re-mounted on every navigation, so each page's sections enter (motion rules at the end of base.css;
 * `display: contents`, so it adds no box and no layout of its own).
 */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
