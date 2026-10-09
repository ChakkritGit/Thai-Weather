import { PanelSkeleton } from '@/components/States';

/** Default route placeholder: the map layout (map route is the most common entry point). */
export default function Loading() {
  return (
    <div className="map-page" aria-busy="true">
      <div className="map-stage" />
      <aside className="map-sidebar">
        <PanelSkeleton />
      </aside>
    </div>
  );
}
