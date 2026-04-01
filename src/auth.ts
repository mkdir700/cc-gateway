import { randomBytes } from 'crypto'
import type { IncomingMessage } from 'http'
import type { Config, TokenEntry } from './config.js'

const tokenMap = new Map<string, TokenEntry>()

export function initAuth(config: Config) {
  tokenMap.clear()
  for (const entry of config.auth.tokens) {
    tokenMap.set(entry.token, entry)
  }
}

export function generateGatewayToken(): string {
  return `sk-${randomBytes(32).toString('hex')}`
}

/**
 * Authenticate incoming request by Bearer token.
 * Returns the token entry name (for audit logging) or null if unauthorized.
 */
export function authenticate(req: IncomingMessage): string | null {
  const candidates = [
    req.headers['x-api-key'],
    req.headers['proxy-authorization'],
    req.headers['authorization'],
  ]

  for (const header of candidates) {
    if (typeof header !== 'string') continue

    const token = extractToken(header)
    const entry = tokenMap.get(token)
    if (entry) return entry.name
  }

  return null
}

function extractToken(header: string): string {
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : header.trim()
}
