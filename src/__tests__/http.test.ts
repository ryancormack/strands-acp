import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client'
import type { Agent } from '@strands-agents/sdk'
import { createHttpHandler, type AcpHttpHandler } from '../http.js'
import type { Principal } from '../acp-agent.js'

const PRINCIPALS: Record<string, Principal> = { alice: { id: 'alice', team: 'red' }, bob: { id: 'bob' } }
const authAs = (name: string) => ({ authorization: `Bearer ${name}` })

class RecordingClient implements Client {
  updates: SessionNotification[] = []
  async requestPermission() {
    return { outcome: { outcome: 'selected' as const, optionId: 'allow_once' } }
  }
  async sessionUpdate(params: SessionNotification) {
    this.updates.push(params)
  }
}

function createMockAgent(): Agent {
  return {
    messages: [],
    stream: async function* () {
      yield {
        type: 'modelStreamUpdateEvent',
        event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'hi' } },
      } as never
      return { stopReason: 'endTurn' } as never
    },
    cancel: vi.fn(),
  } as unknown as Agent
}

let server: Server | undefined
let handler: AcpHttpHandler | undefined

async function serve(
  authenticate: (request: Request) => Principal | null | Promise<Principal | null>,
  agent: () => Agent = createMockAgent,
): Promise<string> {
  handler = createHttpHandler(() => agent(), { authenticate })
  server = createServer(handler.node)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/acp`
}

const bearerAuth = (request: Request): Principal | null =>
  PRINCIPALS[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''] ?? null

async function connect(url: string, client: Client, as = 'alice') {
  const conn = new ClientSideConnection(() => client, createHttpStream(url, { headers: authAs(as) }))
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return conn
}

afterEach(async () => {
  await handler?.close()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  handler = undefined
})

describe('createHttpHandler', () => {
  it('requires an authenticate function', () => {
    expect(() => createHttpHandler(() => createMockAgent(), {} as never)).toThrow(TypeError)
  })

  it('answers 401 when authenticate rejects the request', async () => {
    const url = await serve(bearerAuth)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
      }),
    })
    expect(response.status).toBe(401)
  })

  it('gates the fetch handler too', async () => {
    handler = createHttpHandler(() => createMockAgent(), { authenticate: bearerAuth })
    const response = await handler.fetch(new Request('http://localhost/acp', { method: 'GET' }))
    expect(response.status).toBe(401)
  })

  it('runs a prompt turn end to end and streams updates over SSE', async () => {
    const url = await serve(bearerAuth)
    const client = new RecordingClient()
    const conn = await connect(url, client)

    const { sessionId } = await conn.newSession({ cwd: '/project', mcpServers: [] })
    const response = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] })

    expect(response.stopReason).toBe('end_turn')
    await vi.waitFor(() =>
      expect(client.updates.map((u) => u.update.sessionUpdate)).toContain('agent_message_chunk'),
    )
  })

  it('keeps a session alive for a client that reconnects', async () => {
    const url = await serve(bearerAuth)
    const first = await connect(url, new RecordingClient())
    const { sessionId } = await first.newSession({ cwd: '/project', mcpServers: [] })

    const client = new RecordingClient()
    const second = await connect(url, client)
    const response = await second.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] })

    expect(response.stopReason).toBe('end_turn')
    await vi.waitFor(() => expect(client.updates.length).toBeGreaterThan(0))
  })

  it('checks every request, not only initialize', async () => {
    const methods: string[] = []
    const url = await serve((request) => {
      methods.push(request.method)
      return bearerAuth(request)
    })
    const conn = await connect(url, new RecordingClient())
    await conn.newSession({ cwd: '/project', mcpServers: [] })

    expect(methods).toContain('GET')
    expect(methods.filter((m) => m === 'POST').length).toBeGreaterThanOrEqual(2)
  })

  it('refuses a principal without an id', async () => {
    handler = createHttpHandler(() => createMockAgent(), { authenticate: () => ({ id: '' }) })
    await expect(handler.fetch(new Request('http://localhost/acp', { method: 'GET' }))).rejects.toThrow(TypeError)
  })
})

describe('createHttpHandler ownership', () => {
  it("does not let one caller prompt or list another's session", async () => {
    const url = await serve(bearerAuth)
    const alice = await connect(url, new RecordingClient(), 'alice')
    const bob = await connect(url, new RecordingClient(), 'bob')
    const { sessionId } = await alice.newSession({ cwd: '/project', mcpServers: [] })

    await expect(bob.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })).rejects.toThrow()
    await expect(bob.closeSession({ sessionId })).rejects.toThrow()
    expect((await bob.listSessions({})).sessions).toEqual([])
    expect((await alice.listSessions({})).sessions.map((s) => s.sessionId)).toEqual([sessionId])
  })

  it("answers 404 to a caller presenting another caller's connection id", async () => {
    const url = await serve(bearerAuth)
    const init = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authAs('alice') },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
      }),
    })
    const connectionId = init.headers.get('acp-connection-id')
    expect(connectionId).toBeTruthy()

    const hijack = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'acp-connection-id': connectionId!, ...authAs('bob') },
    })
    expect(hijack.status).toBe(404)

    const owner = new AbortController()
    const own = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'acp-connection-id': connectionId!, ...authAs('alice') },
      signal: owner.signal,
    })
    expect(own.status).toBe(200)
    owner.abort()
  })

  it('puts the principal on invocationState', async () => {
    const seen: unknown[] = []
    const agent = () =>
      ({
        messages: [],
        stream: async function* (_input: unknown, options?: { invocationState?: unknown }) {
          seen.push(options?.invocationState)
          return { stopReason: 'endTurn' } as never
        },
        cancel: vi.fn(),
      }) as unknown as Agent
    const url = await serve(bearerAuth, agent)
    const conn = await connect(url, new RecordingClient(), 'alice')
    const { sessionId } = await conn.newSession({ cwd: '/project', mcpServers: [] })
    await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })

    expect(seen).toEqual([{ acp: { sessionId, principal: PRINCIPALS.alice } }])
  })
})
