'use client';

/**
 * The map page. It renders on the server too; only its MapLibre map is client-only (see MapPage's
 * `WeatherMap` import), so the sidebar and legend are in the first HTML.
 */
export { default } from './MapPage';
