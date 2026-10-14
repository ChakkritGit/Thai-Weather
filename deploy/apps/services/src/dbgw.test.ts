import { expect, test } from 'bun:test'
import { SignJWT, decodeJwt, exportJWK, generateKeyPair, createLocalJWKSet, jwtVerify } from 'jose'

process.env.SUPABASE_URL = 'https://ref.supabase.co'
process.env.SUPABASE_ANON_KEY = 'anon-key-jwt'
process.env.PGRST_JWT_SECRET = 'x'.repeat(48)
const { identify, restToken } = await import('./dbgw')
const secret = new TextEncoder().encode('x'.repeat(48))

const { publicKey, privateKey } = await generateKeyPair('ES256')
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'k1' }] })
const session = (claims: Record<string, unknown>, iss = 'https://ref.supabase.co/auth/v1') =>
  new SignJWT({ role: 'authenticated', aud: 'authenticated', email: 'me@example.com', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(iss).setSubject('11111111-2222-3333-4444-555555555555').setExpirationTime('1h').sign(privateKey)

test('no token or the anon key → anon, no token for PostgREST', async () => {
  expect(await identify(null, jwks)).toEqual({ role: 'anon' })
  expect(await identify('Bearer anon-key-jwt', jwks)).toEqual({ role: 'anon' })
  expect(await restToken({ role: 'anon' })).toBeNull()
})

test('a Supabase session becomes our token with the same user id', async () => {
  const c = await identify(`Bearer ${await session({})}`, jwks)
  expect(c?.role).toBe('authenticated')
  const t = (await restToken(c!))!
  const { payload } = await jwtVerify(t, secret, { algorithms: ['HS256'] })
  expect(payload.sub).toBe('11111111-2222-3333-4444-555555555555')
  expect(payload.role).toBe('authenticated')
  expect(payload.exp! - Date.now() / 1000).toBeLessThanOrEqual(3600)
})

test('refuses sessions from another project, another role, or forged', async () => {
  expect(await identify(`Bearer ${await session({}, 'https://evil.supabase.co/auth/v1')}`, jwks)).toBeNull()
  expect(await identify(`Bearer ${await session({ role: 'service_role' })}`, jwks)).toBeNull()
  const forged = await new SignJWT({ role: 'service_role' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode('y'.repeat(48)))
  expect(await identify(`Bearer ${forged}`, jwks)).toBeNull()
})

test('our own service token passes as is', async () => {
  const t = await new SignJWT({ role: 'service_role' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret)
  const c = await identify(`Bearer ${t}`, jwks)
  expect(c).toEqual({ role: 'local', token: t })
  expect(decodeJwt((await restToken(c!))!).role).toBe('service_role')
})
