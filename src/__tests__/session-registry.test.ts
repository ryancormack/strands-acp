import { describe, it, expect, vi } from 'vitest'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AgentApp,
  type Client,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import type { Agent } from '@strands-agents/sdk'
import { createAgentApp } from '../acp-agent.js'
import { SessionRegistry } from '../session-registry.js'

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

async function connect(app: AgentApp, client: Client) {
  const clientToAgent = new TransformStream()
  const agentToClient = new TransformStream()
  const conn = new ClientSideConnection(() => client, ndJsonStream(clientToAgent.writable, agentToClient.readable))
  app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable))
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return conn
}

describe('sessions outlive the connection', () => {
  it('lets a second connection to the same app prompt a session the first created', async () => {
    const app = createAgentApp(() => createMockAgent())
    const first = new RecordingClient()
    const second = new RecordingClient()
    const a = await connect(app, first)
    const b = await connect(app, second)

    const { sessionId } = await a.newSession({ cwd: '/project', mcpServers: [] })
    const response = await b.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] })

    expect(response.stopReason).toBe('end_turn')
    await vi.waitFor(() => expect(second.updates.length).toBeGreaterThan(0))
    expect(first.updates).toHaveLength(0)
  })

  it('shares sessions between apps given the same registry', async () => {
    const sessions = new SessionRegistry()
    const one = createAgentApp({ agentFactory: () => createMockAgent(), sessions })
    const two = createAgentApp({ agentFactory: () => createMockAgent(), sessions })
    const a = await connect(one, new RecordingClient())
    const b = await connect(two, new RecordingClient())

    const { sessionId } = await a.newSession({ cwd: '/project', mcpServers: [] })
    const listed = await b.listSessions({})

    expect(sessions.has(sessionId)).toBe(true)
    expect(listed.sessions.map((s) => s.sessionId)).toEqual([sessionId])
  })

  it('keeps apps without a shared registry apart', async () => {
    const a = await connect(createAgentApp(() => createMockAgent()), new RecordingClient())
    const b = await connect(createAgentApp(() => createMockAgent()), new RecordingClient())

    await a.newSession({ cwd: '/project', mcpServers: [] })
    expect((await b.listSessions({})).sessions).toEqual([])
  })

  it('is accepted by the SDK HTTP server as its agent', () => {
    const server = new AcpServer({ agent: createAgentApp(() => createMockAgent()) })
    expect(server).toBeInstanceOf(AcpServer)
    return server.close()
  })
})
