import { createSocket } from 'node:dgram'
import type { Socket } from 'node:dgram'

import { afterEach, describe, expect, it } from 'vitest'

import { RtpSender } from './sender.js'

/** A loopback UDP socket standing in for HomeKit's receiver. */
function receiver(): Promise<{ port: number, received: Buffer[], socket: Socket }> {
  return new Promise(resolve => {
    const socket = createSocket('udp4')
    const received: Buffer[] = []

    socket.on('message', message => { received.push(message) })
    socket.bind(() => { resolve({ port: socket.address().port, received, socket }) })
  })
}

/** Resolve once `predicate` holds, or reject after `timeoutMs`. */
async function eventually(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error('condition was not met in time')
}

const cleanup: (() => void)[] = []

afterEach(() => {
  for (const fn of cleanup.splice(0)) {
    fn()
  }
})

async function sender(port: number): Promise<{ controller: AbortController, sender: RtpSender }> {
  const controller = new AbortController()
  const instance = await RtpSender.bind({
    address: '127.0.0.1',
    addressVersion: 'ipv4',
    port,
    signal: controller.signal,
  })

  cleanup.push(() => { controller.abort() })

  return { controller, sender: instance }
}

describe('RtpSender', () => {
  it('binds a local port and reports it', async () => {
    const target = await receiver()

    cleanup.push(() => { target.socket.close() })

    const { sender: instance } = await sender(target.port)

    expect(instance.localPort).toBeGreaterThan(0)
  })

  it('delivers packets byte for byte', async () => {
    const target = await receiver()

    cleanup.push(() => { target.socket.close() })

    const { sender: instance } = await sender(target.port)
    const packet = Buffer.from([0x80, 0x63, 0x00, 0x01, 0xde, 0xad, 0xbe, 0xef])

    instance.send(packet)
    await eventually(() => target.received.length === 1)

    expect(target.received[0]?.equals(packet)).toBe(true)
  })

  it('counts packets and bytes', async () => {
    const target = await receiver()

    cleanup.push(() => { target.socket.close() })

    const { sender: instance } = await sender(target.port)

    instance.send(Buffer.alloc(100))
    instance.send(Buffer.alloc(200))
    await eventually(() => instance.stats.packetsSent === 2)

    expect(instance.stats.bytesSent).toBe(300)
    expect(instance.stats.firstPacketAt).not.toBeNull()
  })

  it('records the time of the first packet only', async () => {
    const target = await receiver()

    cleanup.push(() => { target.socket.close() })

    const { sender: instance } = await sender(target.port)

    instance.send(Buffer.alloc(10))
    await eventually(() => instance.stats.packetsSent === 1)

    const first = instance.stats.firstPacketAt

    instance.send(Buffer.alloc(10))
    await eventually(() => instance.stats.packetsSent === 2)

    expect(instance.stats.firstPacketAt).toBe(first)
  })

  it('counts inbound datagrams, which is how we see HomeKit is still there', async () => {
    const target = await receiver()

    cleanup.push(() => { target.socket.close() })

    const { sender: instance } = await sender(target.port)

    target.socket.send(Buffer.from([0x80, 0xc9]), instance.localPort, '127.0.0.1')
    await eventually(() => instance.stats.inboundPackets === 1)

    expect(instance.stats.lastInboundAt).not.toBeNull()
  })

  it('stops sending once closed', async () => {
    const target = await receiver()

    cleanup.push(() => { target.socket.close() })

    const { sender: instance } = await sender(target.port)

    instance.close()
    instance.send(Buffer.alloc(10))

    expect(instance.closed).toBe(true)
    expect(instance.stats.packetsSent).toBe(0)
  })

  it('closes when its signal aborts', async () => {
    const target = await receiver()

    cleanup.push(() => { target.socket.close() })

    const { controller, sender: instance } = await sender(target.port)

    controller.abort()
    expect(instance.closed).toBe(true)
  })

  it('tolerates being closed twice', async () => {
    const target = await receiver()

    cleanup.push(() => { target.socket.close() })

    const { sender: instance } = await sender(target.port)

    instance.close()
    expect(() => { instance.close() }).not.toThrow()
  })
})
