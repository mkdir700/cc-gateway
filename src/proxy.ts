import { createServer as createHttpsServer, type ServerOptions } from 'https'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { request as httpsRequest } from 'https'
import { URL } from 'url'
import type { Config } from './config.js'
import { authenticate, initAuth } from './auth.js'
import { getAccessToken } from './oauth.js'
import { rewriteBody, rewriteHeaders } from './rewriter.js'
import { audit, enqueueDebugLog, log } from './logger.js'

export function startProxy(config: Config) {
  initAuth(config)

  const upstream = new URL(config.upstream.url)
  const useTls = config.server.tls?.cert && config.server.tls?.key

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    req.on('error', () => {})
    res.on('error', () => {})
    handleRequest(req, res, config, upstream).catch(err => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return
      log('error', `Unhandled request error: ${err}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    })
  }

  let server
  if (useTls) {
    const tlsOptions: ServerOptions = {
      cert: readFileSync(config.server.tls.cert),
      key: readFileSync(config.server.tls.key),
    }
    server = createHttpsServer(tlsOptions, handler)
  } else {
    server = createHttpServer(handler)
    log('warn', 'Running without TLS - only use for local development')
  }

  server.listen(config.server.port, () => {
    log('info', `CC Gateway listening on ${useTls ? 'https' : 'http'}://0.0.0.0:${config.server.port}`)
    log('info', `Upstream: ${config.upstream.url}`)
    log('info', `Canonical device_id: ${config.identity.device_id.slice(0, 8)}...`)
    log('info', `Authorized clients: ${config.auth.tokens.map(t => t.name).join(', ')}`)
  })

  return server
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  upstream: URL,
) {
  const method = req.method || 'GET'
  const path = req.url || '/'

  // Health check - no auth required
  if (path === '/_health') {
    const oauthOk = !!getAccessToken()
    const status = oauthOk ? 200 : 503
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: oauthOk ? 'ok' : 'degraded',
      oauth: oauthOk ? 'valid' : 'expired/refreshing',
      canonical_device: config.identity.device_id.slice(0, 8) + '...',
      canonical_platform: config.env.platform,
      upstream: config.upstream.url,
      clients: config.auth.tokens.map(t => t.name),
    }))
    return
  }

  // Dry-run verification - shows what would be rewritten (auth required)
  if (path === '/_verify') {
    const clientName = authenticate(req)
    if (!clientName) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const sample = buildVerificationPayload(config)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(sample, null, 2))
    return
  }

  // Authenticate client (proxy-level auth)
  const clientName = authenticate(req)
  if (!clientName) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized - provide Bearer token in Authorization or Proxy-Authorization header' }))
    log('warn', `Unauthorized request: ${method} ${path}`)
    return
  }

  // Get the real OAuth token (managed by gateway)
  const oauthToken = getAccessToken()
  if (!oauthToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'OAuth token not available - gateway is refreshing' }))
    log('error', 'No valid OAuth token available')
    return
  }

  // Collect request body
  const chunks: Buffer[] = []
  try {
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request aborted' }))
    }
    return
  }
  let body = Buffer.concat(chunks)
  const originalBody = body

  log('debug', 'Inbound request', buildDebugRequestSnapshot(
    method,
    path,
    req.headers as Record<string, string | string[] | undefined>,
    body.length,
  ))

  // Rewrite identity fields in body
  if (body.length > 0) {
    try {
      body = rewriteBody(body, path, config) as Buffer<ArrayBuffer>
    } catch (err) {
      log('error', `Body rewrite failed for ${path}: ${err}`)
    }
  }

  // Rewrite headers (strips client auth, normalizes identity headers)
  const rewrittenHeaders = rewriteHeaders(
    req.headers as Record<string, string | string[] | undefined>,
    config,
  )

  const upstreamHeaders = buildUpstreamHeaders(
    rewrittenHeaders,
    config,
    oauthToken,
    body.length,
    upstream.host,
  )

  log('debug', 'Outbound request', buildDebugRequestSnapshot(
    method,
    path,
    upstreamHeaders,
    body.length,
  ))

  enqueueDebugLog(
    'Rewrite diff',
    buildRewriteDiffLogEntry(
      method,
      path,
      req.headers as Record<string, string | string[] | undefined>,
      upstreamHeaders,
      originalBody,
      body,
    ),
  )

  // Forward to upstream
  const upstreamUrl = new URL(path, upstream)

  const proxyReq = httpsRequest(
    upstreamUrl,
    {
      method,
      headers: upstreamHeaders,
      timeout: 30000,
    },
    (proxyRes) => {
      const status = proxyRes.statusCode || 502

      const responseHeaders = { ...proxyRes.headers }
      delete responseHeaders['transfer-encoding']

      res.writeHead(status, responseHeaders)

      proxyRes.on('error', () => res.destroy())

      // Stream response directly (SSE for Claude responses)
      proxyRes.pipe(res)

      if (config.logging.audit) {
        audit(clientName, method, path, status)
      }
    },
  )

  proxyReq.on('timeout', () => {
    proxyReq.destroy()
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Gateway timeout' }))
    }
    if (config.logging.audit) {
      audit(clientName, method, path, 504)
    }
  })

  proxyReq.on('error', (err) => {
    log('error', `Upstream error: ${err.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Bad gateway', detail: err.message }))
    }
    if (config.logging.audit) {
      audit(clientName, method, path, 502)
    }
  })

  proxyReq.write(body)
  proxyReq.end()
}

export function buildDebugRequestSnapshot(
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  bodyBytes: number,
) {
  const normalized: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    const headerValue = Array.isArray(value) ? value.join(', ') : value
    normalized[key.toLowerCase()] = redactHeaderValue(key, headerValue)
  }

  return {
    method,
    path,
    body_bytes: bodyBytes,
    headers: normalized,
  }
}

export function buildUpstreamHeaders(
  headers: Record<string, string | string[] | undefined>,
  config: Config,
  oauthToken: string,
  bodyLength: number,
  upstreamHost: string,
): Record<string, string> {
  const rewrittenHeaders = rewriteHeaders(headers, config)
  const upstreamHeaders: Record<string, string> = {
    ...rewrittenHeaders,
    host: upstreamHost,
    'content-length': String(bodyLength),
    authorization: `Bearer ${oauthToken}`,
  }

  upstreamHeaders['anthropic-beta'] = ensureBetaFlag(
    upstreamHeaders['anthropic-beta'],
    'oauth-2025-04-20',
  )

  return upstreamHeaders
}

export function buildRewriteDiffLogEntry(
  method: string,
  path: string,
  beforeHeaders: Record<string, string | string[] | undefined>,
  afterHeaders: Record<string, string | string[] | undefined>,
  beforeBody: Buffer,
  afterBody: Buffer,
) {
  return {
    method,
    path,
    headers_changed: diffHeaderSnapshots(beforeHeaders, afterHeaders),
    body_changed: diffBodies(beforeBody, afterBody),
  }
}

function redactHeaderValue(key: string, value: string): string {
  const lower = key.toLowerCase()
  if (lower === 'authorization' || lower === 'proxy-authorization') {
    const match = value.match(/^Bearer\s+(.+)$/i)
    return match ? 'Bearer ***' : '***'
  }
  if (lower === 'x-api-key') {
    return '***'
  }
  return value
}

function ensureBetaFlag(existing: string | undefined, required: string): string {
  if (!existing) return required

  const flags = existing
    .split(',')
    .map(flag => flag.trim())
    .filter(Boolean)

  if (!flags.includes(required)) {
    flags.push(required)
  }

  return flags.join(',')
}

function diffHeaderSnapshots(
  beforeHeaders: Record<string, string | string[] | undefined>,
  afterHeaders: Record<string, string | string[] | undefined>,
): Record<string, { before?: string, after?: string }> {
  const before = buildDebugRequestSnapshot('IN', '', beforeHeaders, 0).headers
  const after = buildDebugRequestSnapshot('OUT', '', afterHeaders, 0).headers
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: Record<string, { before?: string, after?: string }> = {}

  for (const key of keys) {
    if (before[key] === after[key]) continue
    changed[key] = {
      before: before[key],
      after: after[key],
    }
  }

  return changed
}

function diffBodies(
  beforeBody: Buffer,
  afterBody: Buffer,
): Record<string, { before: unknown, after: unknown }> {
  if (beforeBody.equals(afterBody)) return {}

  const before = parseBodyForDiff(beforeBody)
  const after = parseBodyForDiff(afterBody)
  if (before === undefined || after === undefined) {
    return {
      body: {
        before: summarizeScalar(beforeBody.toString('utf-8')),
        after: summarizeScalar(afterBody.toString('utf-8')),
      },
    }
  }

  const changed: Record<string, { before: unknown, after: unknown }> = {}
  collectChangedFields(before, after, '', changed)
  return changed
}

function parseBodyForDiff(body: Buffer): unknown {
  try {
    return normalizeBodyForDiff(JSON.parse(body.toString('utf-8')))
  } catch {
    return undefined
  }
}

function normalizeBodyForDiff(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'user_id') {
      try {
        return normalizeBodyForDiff(JSON.parse(value))
      } catch {
        return summarizeScalar(value)
      }
    }
    return summarizeScalar(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeBodyForDiff(item))
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {}
    for (const [entryKey, entryValue] of Object.entries(value)) {
      normalized[entryKey] = normalizeBodyForDiff(entryValue, entryKey)
    }
    return normalized
  }

  return value
}

function collectChangedFields(
  before: unknown,
  after: unknown,
  path: string,
  changed: Record<string, { before: unknown, after: unknown }>,
) {
  if (deepEqual(before, after)) return

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      const nextPath = path ? `${path}.${key}` : key
      collectChangedFields(before[key], after[key], nextPath, changed)
    }
    return
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const maxLength = Math.max(before.length, after.length)
    for (let index = 0; index < maxLength; index++) {
      const nextPath = `${path}[${index}]`
      collectChangedFields(before[index], after[index], nextPath, changed)
    }
    return
  }

  changed[path || 'body'] = {
    before: summarizeScalar(before),
    after: summarizeScalar(after),
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function summarizeScalar(value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (value.length <= 160) return value
  return `${value.slice(0, 157)}...`
}

/**
 * Build a sample payload showing what the rewriter produces.
 * Used by /_verify endpoint for admin validation.
 */
function buildVerificationPayload(config: Config) {
  // Simulate a /v1/messages request body
  const sampleInput = {
    metadata: {
      user_id: JSON.stringify({
        device_id: 'REAL_DEVICE_ID_FROM_CLIENT_abc123',
        account_uuid: 'shared-account-uuid',
        session_id: 'session-xxx',
      }),
    },
    system: [
      {
        type: 'text',
        text: `x-anthropic-billing-header: cc_version=2.1.81.a1b; cc_entrypoint=cli;`,
      },
      {
        type: 'text',
        text: `Here is useful information about the environment:\n<env>\nWorking directory: /home/bob/myproject\nPlatform: linux\nShell: bash\nOS Version: Linux 6.5.0-generic\n</env>`,
      },
    ],
    messages: [{ role: 'user', content: 'hello' }],
  }

  const rewritten = JSON.parse(
    rewriteBody(Buffer.from(JSON.stringify(sampleInput)), '/v1/messages', config).toString('utf-8'),
  )

  return {
    _info: 'This shows how the gateway rewrites a sample request',
    before: {
      'metadata.user_id': JSON.parse(sampleInput.metadata.user_id),
      system_prompt_env: sampleInput.system[1].text,
      billing_header: sampleInput.system[0].text,
    },
    after: {
      'metadata.user_id': JSON.parse(rewritten.metadata.user_id),
      system_prompt_env: rewritten.system[1].text,
      billing_header: rewritten.system[0].text,
    },
  }
}
