/**
 * status.chakkritton.com on Cloudflare (deploy/status-worker/wrangler.toml): a 5-minute cron that checks
 * every app, keeps the state in KV and serves the page. It runs off the VPS on purpose, so a VPS that is
 * down or rebooting still shows as down and still raises an alert (by e-mail when Dock is down with it).
 * What only the VPS can see (containers, internal services) comes from its health endpoint.
 */
import { EmailMessage } from 'cloudflare:email'
import OG from './og.png'
import { handle } from './page'
import { load, tick, type Mailer, type Store } from './run'
import type { Env } from './types'

interface WorkerEnv extends Env {
  STATUS: Store
  /** send_email binding, locked to ALERT_TO (Email Routing's verified address) */
  EMAIL?: { send(message: EmailMessage): Promise<void> }
  ALERT_FROM?: string
  ALERT_TO?: string
}

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const wrap = (s: string) => b64(s).replace(/.{76}/g, '$&\r\n')

/** multipart/alternative: plain text, then the HTML version (built by hand, one fixed shape). */
function mailer(env: WorkerEnv): Mailer | undefined {
  const { EMAIL, ALERT_FROM: from, ALERT_TO: to } = env
  if (!EMAIL || !from || !to) return undefined
  return async ({ subject, text, html }) => {
    const boundary = `b-${crypto.randomUUID()}`
    const part = (type: string, body: string) =>
      [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap(body)].join('\r\n')
    const raw = [
      `From: =?UTF-8?B?${b64('สถานะระบบ chakkritton.com')}?= <${from}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Message-ID: <${crypto.randomUUID()}@${from.split('@')[1]}>`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      part('text/plain', text),
      part('text/html', html),
      `--${boundary}--`,
      '',
    ].join('\r\n')
    await EMAIL.send(new EmailMessage(from, to, raw))
  }
}

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    return handle(req, await load(env.STATUS), Date.now(), OG)
  },
  async scheduled(controller: { scheduledTime: number }, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(tick(env, env.STATUS, controller.scheduledTime, mailer(env)))
  },
}
