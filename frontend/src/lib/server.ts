import { cookies } from 'next/headers';
import { isLang, type Lang } from '@/i18n/dict';
import type { Theme } from './theme';

const API = (process.env.THWX_API_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');

/** Server-side GET against the FastAPI backend; null when it is unreachable or warming up. */
export async function fromApi<T>(path: string, revalidate = 120): Promise<T | null> {
  try {
    const r = await fetch(`${API}${path}`, { next: { revalidate } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function getPrefs(): Promise<{ lang: Lang; theme: Theme | null }> {
  const jar = await cookies();
  const lang = jar.get('thwx.lang')?.value;
  const theme = jar.get('thwx.theme')?.value;
  return {
    lang: isLang(lang) ? lang : 'th',
    theme: theme === 'light' || theme === 'dark' ? theme : null,
  };
}

export const siteUrl = () => (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
