#!/usr/bin/env bun

import { mergedEnv } from './env-file.ts'

const env = mergedEnv(process.env.CODEX_SMS_ENV ?? '.env.sms')
const sid = env.TWILIO_ACCOUNT_SID
const token = env.TWILIO_AUTH_TOKEN
const fromNumber = env.TWILIO_FROM_NUMBER
const smsUrl = env.CODEX_SMS_PUBLIC_URL

if (!sid || !token || !fromNumber || !smsUrl) {
  fail('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, CODEX_SMS_PUBLIC_URL 값이 필요합니다.')
}

const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`
const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`

const listUrl = `${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(fromNumber)}`
const listRes = await fetch(listUrl, { headers: { authorization: auth } })
if (!listRes.ok) fail(`Twilio 번호 조회 실패: ${listRes.status} ${await listRes.text()}`)

const list = await listRes.json() as { incoming_phone_numbers?: { sid: string; phone_number: string }[] }
const phone = list.incoming_phone_numbers?.[0]
if (!phone) fail(`Twilio 번호를 찾지 못했습니다: ${fromNumber}`)

const params = new URLSearchParams({ SmsUrl: smsUrl, SmsMethod: 'POST' })
const updateRes = await fetch(`${base}/IncomingPhoneNumbers/${phone.sid}.json`, {
  method: 'POST',
  headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
  body: params,
})
if (!updateRes.ok) fail(`Twilio 웹훅 설정 실패: ${updateRes.status} ${await updateRes.text()}`)

console.log(`Twilio SMS webhook set: ${fromNumber} -> ${smsUrl}`)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
