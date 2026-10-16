import { PageSkeleton } from '@/components/States';

/** Its own placeholder: without one the root loading.tsx (the map's) showed here. */
export default function Loading() {
  return <PageSkeleton variant="article" />;
}
