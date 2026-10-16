/**
 * The alert e-mail (sent only when Dock cannot be reached): a plain-text part and a minimal HTML part in
 * the status page's look. Tables and inline styles, since mail clients ignore most CSS.
 */
import type { Message } from './run'

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const when = (ms: number) =>
  new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms)

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans Thai',Tahoma,sans-serif"
const RED = '#d6322e'
const GREEN = '#3f9d4a'
const URL_ = 'https://status.chakkritton.com'

export function alertEmail(messages: Message[], now: number) {
  const down = messages.filter((m) => m.kind === 'down').length
  const subject = messages.length === 1 ? messages[0].title : `${messages[0].title} และอีก ${messages.length - 1} รายการ`
  const lead = down ? 'ติดต่อเซิร์ฟเวอร์ไม่ได้ จึงแจ้งทางอีเมลแทน Dock' : 'ระบบกลับมาแล้ว'
  const text = [...messages.map((m) => `${m.kind === 'down' ? '●' : '○'} ${m.title} — ${m.body}`), '', `${lead} · ${when(now)}`, `ดูรายละเอียด: ${URL_}`].join('\n')

  // one alert: the title says it all, so no list under it
  const rows = messages.length === 1 ? '' : messages
    .map(
      (m, i) => `<tr><td style="padding:14px 0;${i ? 'border-top:1px solid #ececec;' : ''}">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="top" style="padding:7px 12px 0 0"><div style="width:8px;height:8px;border-radius:4px;background:${m.kind === 'down' ? RED : GREEN}"></div></td>
<td style="font:600 15px/1.45 ${FONT};color:#1a1a17">${esc(m.title)}<div style="font:400 13px/1.5 ${FONT};color:#6b6b63">${esc(m.body)}</div></td>
</tr></table></td></tr>`,
    )
    .join('')

  const html = `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f6f2">
<div style="display:none;max-height:0;overflow:hidden">${esc(messages.map((m) => m.title).join(' · '))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f6f2"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px">
<tr><td style="padding:0 4px 20px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="width:22px;height:22px;background:#0000ff"></td>
<td style="padding-left:10px;font:700 15px/1 ${FONT};color:#1a1a17">สถานะระบบ</td>
</tr></table></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e3e3dc;border-radius:14px;padding:22px 24px">
<div style="font:700 20px/1.35 ${FONT};color:#1a1a17;margin:0 0 4px">${esc(subject)}</div>
<div style="font:400 13px/1.5 ${FONT};color:#6b6b63;margin:0 0 6px">${messages.length === 1 ? `${esc(messages[0].body)}<br>` : ''}${esc(lead)} · <span style="white-space:nowrap">${esc(when(now))}</span></div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:${messages.length === 1 ? 18 : 14}px"><tr>
<td style="background:#1a1a17;border-radius:8px"><a href="${URL_}" style="display:inline-block;padding:10px 18px;font:600 14px/1 ${FONT};color:#ffffff;text-decoration:none">ดูหน้าสถานะ</a></td>
</tr></table>
</td></tr>
<tr><td style="padding:16px 4px 0;font:400 12px/1.6 ${FONT};color:#9a9a90">ส่งอัตโนมัติจาก status.chakkritton.com <span style="white-space:nowrap">เมื่อแจ้งเตือนผ่าน Dock ไม่ได้</span></td></tr>
</table></td></tr></table>
</body></html>`
  return { subject, text, html }
}
