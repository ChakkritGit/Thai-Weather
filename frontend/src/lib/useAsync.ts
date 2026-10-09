import { useEffect, useState } from 'react';

const cache = new Map<string, Promise<unknown>>();

/** Fetch once per key (e.g. per forecast run) and share the result across components. */
export function useAsync<T>(key: string | null, fn: () => Promise<T>): { data: T | null; error: Error | null; loading: boolean } {
  const [state, setState] = useState<{ data: T | null; error: Error | null; key: string | null }>({ data: null, error: null, key: null });
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let p = cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    p.then(
      (data) => !cancelled && setState({ data, error: null, key }),
      (error: Error) => !cancelled && setState({ data: null, error, key }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = state.key === key;
  return { data: fresh ? state.data : null, error: fresh ? state.error : null, loading: !!key && !fresh };
}
