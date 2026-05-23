import { createHmac, timingSafeEqual } from 'crypto'

export function verifyTwilioSignature(
  req: Request,
  form: URLSearchParams,
  rawBody: string,
  publicUrl: string | undefined,
): boolean {
  if (process.env.CODEX_SMS_SKIP_TWILIO_SIGNATURE === 'true') return true
  const token = process.env.TWILIO_AUTH_TOKEN
  const signature = req.headers.get('x-twilio-signature')
  if (!token || !signature) return false

  const signedUrl = publicUrl ?? req.url
  const base = req.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
    ? signedUrl + [...form.keys()].sort().map(k => `${k}${form.get(k) ?? ''}`).join('')
    : signedUrl + rawBody
  return safeEqual(signature, createHmac('sha1', token).update(base).digest('base64'))
}

export async function sendSms(to: string, body: string): Promise<void> {
  if (process.env.CODEX_SMS_DRY_RUN === 'true') {
    process.stderr.write(`[codex-sms] dry-run SMS to ${to}: ${body}\n`)
    return
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_FROM_NUMBER
  if (!sid || !token || !from) {
    process.stderr.write(`[codex-sms] missing Twilio outbound env; SMS to ${to}: ${body}\n`)
    return
  }

  for (const chunk of chunkSms(body)) {
    const params = new URLSearchParams({ To: to, From: from, Body: chunk })
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params,
    })
    if (!res.ok) process.stderr.write(`[codex-sms] Twilio send failed ${res.status}: ${await res.text()}\n`)
  }
}

export function twiml(message: string): Response {
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return new Response(`<Response><Message>${escaped}</Message></Response>`, {
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  })
}

export function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, '')
}

export function summarizeForSms(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= 2800) return trimmed
  return `${trimmed.slice(0, 2700)}\n\n...결과가 길어 앞부분만 보냅니다. 이어서 보려면 /status 후 추가 지시를 보내세요.`
}

function chunkSms(text: string): string[] {
  const limit = 1400
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit))
  return chunks
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
