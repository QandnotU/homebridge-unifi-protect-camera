/**
 * A single UniFi Protect controller (an NVR, UDM Pro, Cloud Key, etc.).
 */
export interface ControllerConfig {
  /** Friendly name used in logs. Defaults to the host until the controller reports its own name. */
  readonly name?: string

  /** Hostname or IP address of the Protect controller. Local addresses only — no cloud. */
  readonly host: string

  /** A dedicated local Protect user. Do not reuse a UI Cloud account. */
  readonly username: string

  readonly password: string

  /**
   * Verify the controller's TLS certificate. Off by default: Protect controllers use a
   * self-signed certificate unless you have installed your own.
   */
  readonly verifyTls?: boolean
}

/**
 * Plugin-wide options. Per-camera overrides land here in a later phase.
 */
export interface PluginOptions {
  /**
   * Maximum HomeKit Quality. Advertise every legitimate resolution, always prefer the
   * highest-quality compatible Protect source, and never voluntarily drop to a lower
   * stream to save bandwidth. Prioritises image quality over CPU and network cost.
   *
   * This never overrides what HomeKit actually negotiated — it only changes which
   * source we choose to satisfy that request.
   */
  readonly maximumQuality?: boolean

  /**
   * Emit the full per-session diagnostic record (stream negotiation, chosen Protect
   * source, delivery mode, timings) rather than the one-line summary.
   */
  readonly verboseDiagnostics?: boolean
}

/**
 * The plugin configuration after validation and defaulting. Everything here is known
 * good — the platform does not re-check it.
 */
export interface ResolvedConfig {
  readonly controllers: readonly ResolvedControllerConfig[]
  readonly options: Required<PluginOptions>
}

export interface ResolvedControllerConfig {
  readonly name: string
  readonly host: string
  readonly username: string
  readonly password: string
  readonly verifyTls: boolean
}
