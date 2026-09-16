import type { Logging } from 'homebridge'

/**
 * A logger that carries a scope prefix, so a line from one camera is attributable at a
 * glance without every call site repeating the name.
 *
 * Debug output is gated by Homebridge itself (`homebridge -D`); we do not add a second
 * switch for it.
 */
export interface ScopedLogger {
  info: (message: string, ...parameters: unknown[]) => void
  success: (message: string, ...parameters: unknown[]) => void
  warn: (message: string, ...parameters: unknown[]) => void
  error: (message: string, ...parameters: unknown[]) => void
  debug: (message: string, ...parameters: unknown[]) => void

  /** Derive a child logger, e.g. `controller.scope('Front Door')`. */
  scope: (name: string) => ScopedLogger
}

function prefixed(prefix: string, message: string): string {
  return prefix.length > 0 ? `[${prefix}] ${message}` : message
}

/**
 * Wrap a Homebridge {@link Logging} instance with an optional scope.
 *
 * Scopes nest: `createLogger(log, 'NVR').scope('Driveway')` prefixes `[NVR › Driveway]`.
 */
export function createLogger(base: Logging, prefix = ''): ScopedLogger {
  return {
    debug: (message, ...parameters) => { base.debug(prefixed(prefix, message), ...parameters) },
    error: (message, ...parameters) => { base.error(prefixed(prefix, message), ...parameters) },
    info: (message, ...parameters) => { base.info(prefixed(prefix, message), ...parameters) },
    scope: (name: string) => createLogger(base, prefix.length > 0 ? `${prefix} › ${name}` : name),
    success: (message, ...parameters) => { base.success(prefixed(prefix, message), ...parameters) },
    warn: (message, ...parameters) => { base.warn(prefixed(prefix, message), ...parameters) },
  }
}
