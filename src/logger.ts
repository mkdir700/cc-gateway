type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type LogExtra = Record<string, unknown>
type LogWriter = (level: LogLevel, message: string, extra?: LogExtra) => void
type LogScheduler = (task: () => void) => void

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let currentLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel) {
  currentLevel = level
}

export function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel]
}

export function log(level: LogLevel, message: string, extra?: LogExtra) {
  if (!shouldLog(level)) return

  const ts = new Date().toISOString()
  const prefix = `[${ts}] [${level.toUpperCase().padEnd(5)}]`

  if (extra) {
    console.log(`${prefix} ${message}`, JSON.stringify(extra))
  } else {
    console.log(`${prefix} ${message}`)
  }
}

export function audit(clientName: string, method: string, path: string, status: number) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] [AUDIT] client=${clientName} ${method} ${path} → ${status}`)
}

export function enqueueDebugLog(
  message: string,
  extra?: LogExtra,
  scheduler: LogScheduler = (task) => { setImmediate(task) },
  writer: LogWriter = log,
) {
  if (!shouldLog('debug')) return
  scheduler(() => writer('debug', message, extra))
}
