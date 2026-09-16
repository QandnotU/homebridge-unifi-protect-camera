import type { PlatformConfig } from 'homebridge'

import { describe, expect, it } from 'vitest'

import { PLATFORM_NAME } from './settings.js'
import { validateConfig } from './config.js'

function platformConfig(extra: Record<string, unknown>): PlatformConfig {
  return { platform: PLATFORM_NAME, ...extra }
}

const validController = { host: '192.168.1.1', password: 'secret', username: 'homebridge' }

describe('validateConfig', () => {
  it('rejects a config with no controllers key', () => {
    const { config, issues } = validateConfig(platformConfig({}))

    expect(config).toBeNull()
    expect(issues).toHaveLength(1)
    expect(issues[0]?.fatal).toBe(true)
  })

  it('rejects an empty controllers array', () => {
    const { config, issues } = validateConfig(platformConfig({ controllers: [] }))

    expect(config).toBeNull()
    expect(issues[0]?.fatal).toBe(true)
  })

  it('resolves a valid controller and applies defaults', () => {
    const { config, issues } = validateConfig(platformConfig({ controllers: [validController] }))

    expect(issues).toHaveLength(0)
    expect(config?.controllers).toHaveLength(1)
    expect(config?.controllers[0]).toEqual({
      host: '192.168.1.1',
      name: '192.168.1.1',
      password: 'secret',
      username: 'homebridge',
      verifyTls: false,
    })
    expect(config?.options).toEqual({ maximumQuality: false, verboseDiagnostics: false })
  })

  it('keeps an explicit name and TLS setting', () => {
    const { config } = validateConfig(platformConfig({
      controllers: [{ ...validController, name: 'Home NVR', verifyTls: true }],
    }))

    expect(config?.controllers[0]?.name).toBe('Home NVR')
    expect(config?.controllers[0]?.verifyTls).toBe(true)
  })

  it('trims surrounding whitespace and treats blank strings as missing', () => {
    const { config, issues } = validateConfig(platformConfig({
      controllers: [{ host: '  10.0.0.5  ', password: 'secret', username: '   ' }],
    }))

    expect(config).toBeNull()
    expect(issues.some(issue => issue.message.includes('username'))).toBe(true)
  })

  it('skips one bad controller but keeps the good ones', () => {
    const { config, issues } = validateConfig(platformConfig({
      controllers: [validController, { host: '192.168.1.2', username: 'homebridge' }],
    }))

    expect(config?.controllers).toHaveLength(1)
    expect(config?.controllers[0]?.host).toBe('192.168.1.1')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.fatal).toBe(false)
    expect(issues[0]?.message).toContain('password')
  })

  it('never puts credentials into an issue message', () => {
    const { issues } = validateConfig(platformConfig({
      controllers: [{ password: 'hunter2', username: 'homebridge' }],
    }))

    expect(issues.every(issue => !issue.message.includes('hunter2'))).toBe(true)
  })

  it('is fatal when every controller is rejected', () => {
    const { config, issues } = validateConfig(platformConfig({ controllers: [{}, 'nonsense'] }))

    expect(config).toBeNull()
    expect(issues.at(-1)?.fatal).toBe(true)
  })

  it('drops a duplicate host, case-insensitively', () => {
    const { config, issues } = validateConfig(platformConfig({
      controllers: [{ ...validController, host: 'NVR.local' }, { ...validController, host: 'nvr.local' }],
    }))

    expect(config?.controllers).toHaveLength(1)
    expect(issues[0]?.message).toContain('duplicates host')
  })

  it('reads options when present', () => {
    const { config } = validateConfig(platformConfig({
      controllers: [validController],
      options: { maximumQuality: true, verboseDiagnostics: true },
    }))

    expect(config?.options).toEqual({ maximumQuality: true, verboseDiagnostics: true })
  })
})
