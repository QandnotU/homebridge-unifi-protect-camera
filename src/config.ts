import type { PlatformConfig } from 'homebridge'

import type { ResolvedConfig, ResolvedControllerConfig } from './types/config.js'
import { DEFAULT_VERIFY_TLS } from './settings.js'

/**
 * A problem found while validating the user's config.json.
 *
 * `fatal` means the platform cannot start at all. A non-fatal issue means one controller
 * entry was rejected but the others are still usable — a typo in the third controller
 * should not take down the first two.
 */
export interface ConfigIssue {
  readonly fatal: boolean
  readonly message: string
}

export interface ConfigValidationResult {
  readonly config: ResolvedConfig | null
  readonly issues: readonly ConfigIssue[]
}

/** A non-empty string after trimming. */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]

  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()

  return trimmed.length > 0 ? trimmed : null
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key]

  return typeof value === 'boolean' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one controller entry. Returns the resolved controller, or an issue describing
 * why it was rejected.
 *
 * Credentials are never included in an issue message — these are surfaced to the
 * Homebridge log.
 */
function resolveController(raw: unknown, index: number): ResolvedControllerConfig | ConfigIssue {
  const label = `controllers[${index.toString()}]`

  if (!isRecord(raw)) {
    return { fatal: false, message: `${label} is not an object — skipping it.` }
  }

  const host = readString(raw, 'host')
  const username = readString(raw, 'username')
  const password = readString(raw, 'password')

  const missing = [
    host === null ? 'host' : null,
    username === null ? 'username' : null,
    password === null ? 'password' : null,
  ].filter((field): field is string => field !== null)

  if (host === null || username === null || password === null) {
    return {
      fatal: false,
      message: `${label} is missing required ${missing.length === 1 ? 'field' : 'fields'}: ${missing.join(', ')} — skipping it.`,
    }
  }

  return {
    host,
    name: readString(raw, 'name') ?? host,
    password,
    username,
    verifyTls: readBoolean(raw, 'verifyTls', DEFAULT_VERIFY_TLS),
  }
}

function isIssue(value: ResolvedControllerConfig | ConfigIssue): value is ConfigIssue {
  return 'fatal' in value
}

/**
 * Turn the untyped Homebridge `PlatformConfig` into a validated {@link ResolvedConfig}.
 *
 * `PlatformConfig` carries an index signature, so every read from it is `unknown` as far
 * as we are concerned. This is the one place in the plugin that deals with that; from
 * here on the configuration is typed and trusted.
 */
export function validateConfig(platformConfig: PlatformConfig): ConfigValidationResult {
  const issues: ConfigIssue[] = []
  const raw = platformConfig as unknown as Record<string, unknown>

  const rawControllers = raw['controllers']

  if (!Array.isArray(rawControllers) || rawControllers.length === 0) {
    return {
      config: null,
      issues: [{
        fatal: true,
        message: 'No Protect controllers are configured. Add at least one entry under "controllers" with a host, username and password.',
      }],
    }
  }

  const controllers: ResolvedControllerConfig[] = []

  for (const [index, entry] of rawControllers.entries()) {
    const resolved = resolveController(entry, index)

    if (isIssue(resolved)) {
      issues.push(resolved)
      continue
    }

    const duplicate = controllers.find(existing => existing.host.toLowerCase() === resolved.host.toLowerCase())

    if (duplicate) {
      issues.push({ fatal: false, message: `controllers[${index.toString()}] duplicates host ${resolved.host} — skipping it.` })
      continue
    }

    controllers.push(resolved)
  }

  if (controllers.length === 0) {
    return {
      config: null,
      issues: [...issues, { fatal: true, message: 'Every configured controller was rejected. The plugin has nothing to connect to.' }],
    }
  }

  const rawOptions = isRecord(raw['options']) ? raw['options'] : {}

  return {
    config: {
      controllers,
      options: {
        maximumQuality: readBoolean(rawOptions, 'maximumQuality', false),
        verboseDiagnostics: readBoolean(rawOptions, 'verboseDiagnostics', false),
      },
    },
    issues,
  }
}
