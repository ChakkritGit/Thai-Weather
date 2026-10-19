/**
 * Database gateway for the expenses app: Supabase-compatible /rest/v1 and /functions/v1 on the VPS,
 * while login stays on Supabase Auth.
 *
 *   /rest/v1/*                 → PostgREST (apps-rest), the app's own Postgres on the VPS
 *   /functions/v1/push-reminders → the reminders service (apps-reminders)
 *
 * Who is calling decides the Postgres role PostgREST switches to, exactly as on Supabase:
 *   - a Supabase Auth session (ES256, checked against the project's public JWKS) → `authenticated`
 *     with the user's id as `sub`, so the RLS policies (auth.uid()) keep working unchanged;
 *   - a token signed with our own secret (the reminders service's service_role) → as signed;
 *   - nothing / the public anon key → `anon`.
 * PostgREST only trusts our secret, so every request is re-signed here after the check.
 * A user seen for the first time gets a profiles row (what Supabase's on_auth_user_created trigger did).
 */
import { Elysia } from 'elysia'
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'

const PORT = Number(process.env.PORT ?? 8791)
const REST = process.env.REST_URL ?? 'http://apps-rest:3000'
const REMINDERS = process.env.REMINDERS_URL ?? 'http://apps-reminders:8792'
const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ''
const SECRET = new TextEncoder().encode(process.env.PGRST_JWT_SECRET ?? '')

const jwks = SUPABASE_URL ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)) : null

export type Caller = { role: 'anon' } | { role: 'authenticated'; claims: JWTPayload } | { role: 'local'; token: string }

/** Who is this? null = a token that is neither ours nor a valid Supabase session (→ 401). */
export async function identify(authorization: string | null, verifyUser: JWTVerifyGetKey | null = jwks): Promise<Caller | null> {
  const token = authorization?.replace(/^Bearer\s+/i, '').trim() ?? ''
  if (!token || token === ANON_KEY) return { role: 'anon' }
  try {
    await jwtVerify(token, SECRET, { algorithms: ['HS256'] })
    return { role: 'local', token }
  } catch {}
  if (!verifyUser) return null
  try {
    const { payload } = await jwtVerify(token, verifyUser, { issuer: `${SUPABASE_URL}/auth/v1`, audience: 'authenticated' })
    if (payload.role !== 'authenticated' || typeof payload.sub !== 'string') return null
    return { role: 'authenticated', claims: payload }
  } catch {
    // the anon key of the project's legacy API keys is a JWT we cannot check; any other bad token is refused
    return null
  }
}

/** The token PostgREST sees: ours, short-lived, carrying only what the policies need. */
export async function restToken(c: Caller): Promise<string | null> {
  if (c.role === 'anon') return null
  if (c.role === 'local') return c.token
  const { sub, email, exp, session_id, aal, is_anonymous } = c.claims
  return new SignJWT({ role: 'authenticated', aud: 'authenticated', email, session_id, aal, is_anonymous })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub!)
    .setIssuedAt()
    .setExpirationTime(Math.min(exp ?? Infinity, Math.floor(Date.now() / 1000) + 3600))
    .sign(SECRET)
}

let serviceToken: { token: string; until: number } | null = null
async function service() {
  if (serviceToken && serviceToken.until > Date.now() + 60_000) return serviceToken.token
  const token = await new SignJWT({ role: 'service_role' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(SECRET)
  serviceToken = { token, until: Date.now() + 3_600_000 }
  return token
}

const known = new Set<string>()
async function ensureProfile(id: string) {
  if (known.has(id)) return
  const r = await fetch(`${REST}/profiles`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await service()}`, 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ id }),
  })
  if (r.ok) known.add(id)
  else console.error('profile for new user failed', r.status)
}

const HOP = ['host', 'connection', 'content-length', 'accept-encoding', 'apikey', 'authorization', 'x-forwarded-for', 'cf-connecting-ip']

async function forward(request: Request, target: string) {
  const caller = await identify(request.headers.get('authorization'))
  if (!caller) return Response.json({ code: 'PGRST301', message: 'invalid or expired session' }, { status: 401 })
  if (caller.role === 'authenticated') await ensureProfile(caller.claims.sub!)
  const headers = new Headers(request.headers)
  for (const h of HOP) headers.delete(h)
  const token = await restToken(caller)
  if (token) headers.set('authorization', `Bearer ${token}`)
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
    redirect: 'manual',
  })
  const out = new Headers(res.headers)
  out.delete('content-encoding')
  out.delete('content-length')
  return new Response(res.body, { status: res.status, headers: out })
}

export function createApp() {
  return new Elysia()
    .get('/health', async () => {
      const r = await fetch(`${REST}/`, { method: 'HEAD' }).catch(() => null)
      return Response.json({ ok: !!r && r.status < 500 }, { status: r && r.status < 500 ? 200 : 503 })
    })
    // the same paths under /data/: the browser reaches the gateway through the site (expenses…/data/…)
    .all('/rest/v1/*', ({ request }) => rest(request))
    .all('/data/rest/v1/*', ({ request }) => rest(request))
    .all('/functions/v1/push-reminders', ({ request }) => forwardFunction(request))
    .all('/data/functions/v1/push-reminders', ({ request }) => forwardFunction(request))
}

function rest(request: Request) {
  const u = new URL(request.url)
  const path = u.pathname.replace(/^\/data(?=\/)/, '')
  return forward(request, REST + path.slice('/rest/v1'.length) + u.search)
}

/** The function checks callers itself (session, status or cron secret), like it did on Supabase. */
async function forwardFunction(request: Request) {
  const headers = new Headers(request.headers)
  for (const h of ['host', 'connection', 'content-length', 'accept-encoding']) headers.delete(h)
  const res = await fetch(`${REMINDERS}/`, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
  })
  return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
}

