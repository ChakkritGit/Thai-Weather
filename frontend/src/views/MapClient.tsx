'use client';

import dynamic from 'next/dynamic';

/** MapLibre needs `window`, so the interactive map renders on the client only. */
const MapPage = dynamic(() => import('./MapPage'), {
  ssr: false,
  loading: () => (
    <div className="map-page">
      <div className="map-stage" />
      <aside className="map-sidebar">
        <div className="panel" aria-busy="true">
          <div className="skeleton" style={{ height: 28, width: '50%' }} />
          <div className="skeleton" style={{ height: 160 }} />
        </div>
      </aside>
    </div>
  ),
});

export default MapPage;
