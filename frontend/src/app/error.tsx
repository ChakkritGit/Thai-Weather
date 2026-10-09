'use client';

import { ErrorState } from '@/components/States';

/** Route-level error boundary: friendly copy and a retry that re-renders the segment. */
export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page">
      <ErrorState onRetry={reset} minHeight="60vh" />
    </div>
  );
}
