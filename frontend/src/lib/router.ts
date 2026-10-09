import { useEffect, useState } from 'react';

export type Route = { page: 'map' | 'provinces' | 'alerts' | 'method' | 'design'; param?: string };

function parse(): Route {
  const [page, param] = window.location.hash.replace(/^#\/?/, '').split('/');
  const known = ['map', 'provinces', 'alerts', 'method', 'design'] as const;
  return { page: (known as readonly string[]).includes(page) ? (page as Route['page']) : 'map', param };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const href = (page: Route['page'], param?: string) => `#/${page}${param ? `/${param}` : ''}`;
