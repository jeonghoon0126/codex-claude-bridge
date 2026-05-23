import { readFileSync } from 'fs'

export function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  let content = ''
  try { content = readFileSync(path, 'utf8') } catch { return env }

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

export function mergedEnv(path = '.env.sms'): NodeJS.ProcessEnv {
  return { ...process.env, ...loadEnvFile(path) }
}
