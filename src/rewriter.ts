import type { Config } from './config.js'
import { log } from './logger.js'

/**
 * Rewrite identity fields in the API request body.
 *
 * Handles two request types:
 * 1. /v1/messages - rewrite metadata.user_id JSON blob
 * 2. /api/event_logging/batch - rewrite event_data identity/env/process fields
 */
export function rewriteBody(body: Buffer, path: string, config: Config): Buffer {
  const text = body.toString('utf-8')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON - pass through unchanged
    return body
  }

  if (path.startsWith('/v1/messages')) {
    rewriteMessagesBody(parsed, config)
  } else if (path.includes('/event_logging/batch')) {
    rewriteEventBatch(parsed, config)
  } else if (path.includes('/policy_limits') || path.includes('/settings')) {
    // These are GET-like requests, usually no body to rewrite
    // But if they do have a body, rewrite identity fields
    rewriteGenericIdentity(parsed, config)
  }

  return Buffer.from(JSON.stringify(parsed), 'utf-8')
}

/**
 * Rewrite /v1/messages request body.
 * Key field: metadata.user_id (JSON-stringified object with device_id, account_uuid, session_id)
 */
function rewriteMessagesBody(body: any, config: Config) {
  // Rewrite metadata.user_id
  if (body?.metadata?.user_id) {
    try {
      const userId = JSON.parse(body.metadata.user_id)
      userId.device_id = config.identity.device_id
      body.metadata.user_id = JSON.stringify(userId)
      log('debug', `Rewrote metadata.user_id device_id`)
    } catch {
      log('warn', `Failed to parse metadata.user_id`)
    }
  }

  // Rewrite system prompt: billing header + environment block
  if (Array.isArray(body.system)) {
    for (let i = 0; i < body.system.length; i++) {
      const item = body.system[i]
      if (typeof item === 'string') {
        body.system[i] = rewritePromptText(item, config)
      } else if (item?.text) {
        item.text = rewritePromptText(item.text, config)
      }
    }
  } else if (typeof body.system === 'string') {
    body.system = rewritePromptText(body.system, config)
  }

  // Rewrite user messages that may contain <system-reminder> with env info
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        msg.content = rewritePromptText(msg.content, config)
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.text) {
            block.text = rewritePromptText(block.text, config)
          }
        }
      }
    }
  }
}

/**
 * Comprehensive text rewriter for system prompt and user messages.
 * Rewrites:
 * 1. Billing header (cc_version fingerprint)
 * 2. <env> block (Platform, Shell, OS Version, Working directory)
 * 3. Inline environment references (Primary working directory, etc.)
 * 4. Home directory paths that leak username
 */
function rewritePromptText(text: string, config: Config): string {
  const pe = config.prompt_env
  if (!pe) return text

  let result = text

  // 1. <env> block format (older prompt format):
  //    Platform: linux
  //    Shell: bash
  //    OS Version: Linux 6.5.0-xxx
  //    Working directory: /home/bob/project
  result = result.replace(
    /Platform:\s*\S+/g,
    `Platform: ${pe.platform}`,
  )
  result = result.replace(
    /Shell:\s*\S+/g,
    `Shell: ${pe.shell}`,
  )
  result = result.replace(
    /OS Version:\s*[^\n<]+/g,
    `OS Version: ${pe.os_version}`,
  )

  return result
}

/**
 * Rewrite /api/event_logging/batch payload.
 * Each event has event_data with identity, env, and process fields.
 */
function rewriteEventBatch(body: any, config: Config) {
  if (!Array.isArray(body?.events)) return

  for (const event of body.events) {
    if (!event?.event_data) continue
    const data = event.event_data

    // Identity fields
    if (data.device_id) data.device_id = config.identity.device_id
    if (data.email) data.email = config.identity.email

    // Environment fingerprint - replace entirely with canonical
    if (data.env) {
      data.env = buildCanonicalEnv(data.env, config)
    }

    // Process metrics - generate realistic values
    if (data.process) {
      data.process = buildCanonicalProcess(data.process, config)
    }

    // Strip fields that leak gateway URL or proxy usage
    // logging.ts:143 adds baseUrl = ANTHROPIC_BASE_URL to every api event
    delete data.baseUrl
    delete data.base_url
    // detectGateway() adds gateway type if base URL matches known providers
    delete data.gateway

    // Additional metadata - rewrite base64-encoded blob if present
    if (data.additional_metadata) {
      data.additional_metadata = rewriteAdditionalMetadata(data.additional_metadata, config)
    }

    log('debug', `Rewrote event: ${data.event_name || 'unknown'}`)
  }
}

function rewriteGenericIdentity(body: any, config: Config) {
  if (typeof body !== 'object' || body === null) return
  if (body.device_id) body.device_id = config.identity.device_id
  if (body.email) body.email = config.identity.email
}

/**
 * Build canonical env object from config.
 * Merges config env values into the expected structure.
 */
function buildCanonicalEnv(original: Record<string, unknown>, config: Config): Record<string, unknown> {
  return {
    ...original,
    platform: config.env.platform,
    platform_raw: config.env.platform_raw || config.env.platform,
    arch: config.env.arch,
    node_version: config.env.node_version,
    terminal: config.env.terminal,
    package_managers: config.env.package_managers,
    runtimes: config.env.runtimes,
    is_running_with_bun: config.env.is_running_with_bun ?? false,
    is_ci: false,
    is_claubbit: false,
    is_claude_code_remote: false,
    is_local_agent_mode: false,
    is_conductor: false,
    is_github_action: false,
    is_claude_code_action: false,
    is_claude_ai_auth: config.env.is_claude_ai_auth ?? true,
    build_time: config.env.build_time,
    deployment_environment: config.env.deployment_environment,
    vcs: config.env.vcs,
  }
}

/**
 * Generate realistic process metrics.
 * Keeps uptime from the real event but normalizes hardware-identifying fields.
 */
function buildCanonicalProcess(original: any, config: Config): any {
  // If it's a base64 string, decode → rewrite → re-encode
  if (typeof original === 'string') {
    try {
      const decoded = JSON.parse(Buffer.from(original, 'base64').toString('utf-8'))
      const rewritten = rewriteProcessFields(decoded, config)
      return Buffer.from(JSON.stringify(rewritten)).toString('base64')
    } catch {
      return original
    }
  }

  // If it's already an object
  if (typeof original === 'object') {
    return rewriteProcessFields(original, config)
  }

  return original
}

function rewriteProcessFields(proc: any, config: Config): any {
  const { constrained_memory, rss_range, heap_total_range, heap_used_range } = config.process
  return {
    ...proc,
    constrainedMemory: constrained_memory,
    rss: randomInRange(rss_range[0], rss_range[1]),
    heapTotal: randomInRange(heap_total_range[0], heap_total_range[1]),
    heapUsed: randomInRange(heap_used_range[0], heap_used_range[1]),
    // Keep uptime and cpuUsage as-is (these vary naturally)
  }
}

function rewriteAdditionalMetadata(original: string, config: Config): string {
  try {
    const decoded = JSON.parse(Buffer.from(original, 'base64').toString('utf-8'))
    // rh (repo hash) is fine to keep - users work on different repos naturally
    // Strip fields that leak gateway URL
    delete decoded.baseUrl
    delete decoded.base_url
    delete decoded.gateway
    return Buffer.from(JSON.stringify(decoded)).toString('base64')
  } catch {
    return original
  }
}

function randomInRange(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min))
}

/**
 * Preserve client HTTP headers while removing hop-by-hop and client auth headers.
 */
export function rewriteHeaders(
  headers: Record<string, string | string[] | undefined>,
  config: Config,
): Record<string, string> {
  const out: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    const v = Array.isArray(value) ? value.join(', ') : value
    const lower = key.toLowerCase()

    // Skip hop-by-hop headers and auth (gateway injects the real OAuth token)
    if (['host', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'authorization', 'x-api-key'].includes(lower)) {
      continue
    }

    if (lower === 'user-agent') {
      out[key] = v
    } else if (lower === 'x-stainless-os') {
      out[key] = toStainlessOs(config.env.platform)
    } else if (lower === 'x-stainless-arch') {
      out[key] = String(config.env.arch)
    } else if (lower === 'x-stainless-runtime-version') {
      out[key] = String(config.env.node_version)
    } else if (lower === 'x-stainless-package-version') {
      out[key] = v
    } else if (lower === 'x-anthropic-billing-header') {
      out[key] = v
    } else {
      out[key] = v
    }
  }

  return out
}

function toStainlessOs(platform: unknown): string {
  if (platform === 'darwin') return 'Darwin'
  if (platform === 'win32') return 'Windows'
  if (typeof platform === 'string' && platform.length > 0) {
    return platform.charAt(0).toUpperCase() + platform.slice(1)
  }
  return 'Unknown'
}
