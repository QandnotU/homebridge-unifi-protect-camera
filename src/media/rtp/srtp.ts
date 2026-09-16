import { createCipheriv, createHmac, timingSafeEqual } from 'node:crypto'

import { RTP_HEADER_SIZE, SRTP_AUTH_TAG_SIZE } from './h264-packetizer.js'

/** `AES_CM_128_HMAC_SHA1_80` master key length, in bytes. */
export const MASTER_KEY_SIZE = 16

/** `AES_CM_128_HMAC_SHA1_80` master salt length, in bytes. */
export const MASTER_SALT_SIZE = 14

/** HMAC-SHA1 uses the first 20 bytes of the derived authentication key. */
const AUTH_KEY_SIZE = 20

/** Key derivation labels (RFC 3711 §4.3.1). */
const Label = {
  AUTHENTICATION: 0x01,
  ENCRYPTION: 0x00,
  SALT: 0x02,
} as const

/**
 * The AES counter-mode PRF of RFC 3711 §4.3.3.
 *
 * Node's `aes-128-ctr` increments the whole 128-bit counter while AES-CM increments only
 * its low 16 bits. The two agree until that 16-bit field overflows — 2^16 blocks, or 1 MB
 * — which neither a derived key nor a single RTP packet comes close to.
 */
function aesCounterMode(key: Buffer, iv: Buffer, length: number): Buffer {
  const cipher = createCipheriv('aes-128-ctr', key, iv)

  return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]).subarray(0, length)
}

/**
 * Derive one session key from the master key and salt (RFC 3711 §4.3.1).
 *
 * The label is exclusive-ored into the master salt seven bytes from the end: `key_id` is
 * the label followed by a six-byte `index DIV kdr`, right-aligned against the fourteen
 * byte salt. With a key derivation rate of zero that index is always zero, so only the
 * label byte differs between the three derived keys.
 */
export function deriveKey(masterKey: Buffer, masterSalt: Buffer, label: number, length: number): Buffer {
  const iv = Buffer.alloc(16)

  masterSalt.copy(iv, 0, 0, MASTER_SALT_SIZE)
  iv[7] = (iv[7] ?? 0) ^ label

  return aesCounterMode(masterKey, iv, length)
}

export interface SessionKeys {
  readonly encryptionKey: Buffer
  readonly authKey: Buffer
  readonly salt: Buffer
}

export function deriveSessionKeys(masterKey: Buffer, masterSalt: Buffer): SessionKeys {
  return {
    authKey: deriveKey(masterKey, masterSalt, Label.AUTHENTICATION, AUTH_KEY_SIZE),
    encryptionKey: deriveKey(masterKey, masterSalt, Label.ENCRYPTION, MASTER_KEY_SIZE),
    salt: deriveKey(masterKey, masterSalt, Label.SALT, MASTER_SALT_SIZE),
  }
}

/**
 * Encrypts outgoing RTP for one stream.
 *
 * Sender-side only: it protects packets, it never unprotects them. HomeKit hands us the
 * master key and salt during `prepareStream`, and every packet we send must be protected
 * with them or the receiver discards it silently — which looks exactly like a network
 * fault and is not one.
 */
export class SrtpSession {
  readonly #keys: SessionKeys
  readonly #ssrc: number

  /** Rollover counter: how many times the 16-bit sequence number has wrapped. */
  #roc = 0
  #lastSequence: number | null = null

  constructor(masterKey: Buffer, masterSalt: Buffer, ssrc: number) {
    if (masterKey.length !== MASTER_KEY_SIZE) {
      throw new Error(`SRTP master key must be ${MASTER_KEY_SIZE.toString()} bytes, got ${masterKey.length.toString()}`)
    }

    if (masterSalt.length !== MASTER_SALT_SIZE) {
      throw new Error(`SRTP master salt must be ${MASTER_SALT_SIZE.toString()} bytes, got ${masterSalt.length.toString()}`)
    }

    this.#keys = deriveSessionKeys(masterKey, masterSalt)
    this.#ssrc = ssrc >>> 0
  }

  get rolloverCounter(): number {
    return this.#roc
  }

  /**
   * The per-packet initialisation vector (RFC 3711 §4.1.1):
   * `IV = (salt * 2^16) XOR (SSRC * 2^64) XOR (index * 2^16)`.
   */
  #iv(index: number): Buffer {
    const iv = Buffer.alloc(16)

    this.#keys.salt.copy(iv, 0)

    // SSRC occupies bytes 4..7. `>>> 0` because JavaScript's XOR yields a *signed* 32-bit
    // result, which writeUInt32BE rejects for anything with the high bit set.
    iv.writeUInt32BE((iv.readUInt32BE(4) ^ this.#ssrc) >>> 0, 4)

    // The 48-bit packet index occupies bytes 8..13.
    const high = Math.floor(index / 0x100000000)
    const low = index >>> 0

    iv.writeUInt16BE((iv.readUInt16BE(8) ^ (high & 0xffff)) & 0xffff, 8)
    iv.writeUInt32BE((iv.readUInt32BE(10) ^ low) >>> 0, 10)

    return iv
  }

  /**
   * Encrypt an RTP packet and append its authentication tag.
   *
   * The header is left in the clear, as SRTP requires — only the payload is encrypted —
   * and the tag covers the whole packet plus the rollover counter.
   */
  protect(packet: Buffer): Buffer {
    if (packet.length < RTP_HEADER_SIZE) {
      throw new Error(`RTP packet is shorter than its header: ${packet.length.toString()} bytes`)
    }

    const sequence = packet.readUInt16BE(2)

    // We are the sender, so sequence numbers advance by one: a wrap is unambiguous.
    if ((this.#lastSequence !== null) && (sequence < this.#lastSequence) && ((this.#lastSequence - sequence) > 0x8000)) {
      this.#roc += 1
    }

    this.#lastSequence = sequence

    const index = (this.#roc * 0x10000) + sequence
    const header = packet.subarray(0, RTP_HEADER_SIZE)
    const payload = packet.subarray(RTP_HEADER_SIZE)

    const keystream = aesCounterMode(this.#keys.encryptionKey, this.#iv(index), payload.length)
    const encrypted = Buffer.alloc(payload.length)

    for (let offset = 0; offset < payload.length; offset++) {
      encrypted[offset] = (payload[offset] ?? 0) ^ (keystream[offset] ?? 0)
    }

    const protectedPacket = Buffer.concat([header, encrypted])
    const roc = Buffer.alloc(4)

    roc.writeUInt32BE(this.#roc, 0)

    const tag = createHmac('sha1', this.#keys.authKey)
      .update(protectedPacket)
      .update(roc)
      .digest()
      .subarray(0, SRTP_AUTH_TAG_SIZE)

    return Buffer.concat([protectedPacket, tag])
  }
}

/**
 * Verify a protected packet's authentication tag. Test-only — the plugin never receives
 * SRTP — but it makes round-trip assertions meaningful rather than self-referential.
 */
export function verifyAuthTag(protectedPacket: Buffer, authKey: Buffer, roc: number): boolean {
  const body = protectedPacket.subarray(0, protectedPacket.length - SRTP_AUTH_TAG_SIZE)
  const tag = protectedPacket.subarray(protectedPacket.length - SRTP_AUTH_TAG_SIZE)
  const rocBuffer = Buffer.alloc(4)

  rocBuffer.writeUInt32BE(roc, 0)

  const expected = createHmac('sha1', authKey).update(body).update(rocBuffer).digest().subarray(0, SRTP_AUTH_TAG_SIZE)

  return timingSafeEqual(tag, expected)
}
