import { describe, expect, it, vi } from 'vitest'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AgentApp,
  type Client,
  type SessionInfo,
} from '@agentclientprotocol/sdk'
import type { Agent } from '@strands-agents/sdk'
import { createAgentApp, OWNER_META_KEY, type AcpBridgeConfig } from '../acp-agent.js'
import { SessionRegistry } from '../session-registry.js'
import type { SessionStore } from '../session-store.js'

const client: Client = {
  async requestPermission() {
    return { outcome: { outcome: 'selected' as const, optionId: 'allow_once' } }
  },
  async sessionUpdate() {},
}

function createMockAgent(): Agent {
  return {
    messages: [],
    stream: async function* () {
      return { stopReason: 'endTurn' } as never
    },
    cancel: vi.fn(),
  } as unknown as Agent
}

async function connect(app: AgentApp) {
  const clientToAgent = new TransformStream()
  const agentToClient = new TransformStream()
  const conn = new ClientSideConnection(() => client, ndJsonStream(clientToAgent.writable, agentToClient.readable))
  app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable))
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return conn
}

class MemoryStore implements SessionStore {
  records = new Map<string, SessionInfo>()
  async list() {
    return [...this.records.values()]
  }
  async save(info: SessionInfo) {
    this.records.set(info.sessionId, info)
  }
  async delete(sessionId: string) {
    this.records.delete(sessionId)
  }
}

function pair(config: Omit<AcpBridgeConfig, 'sessions'>) {
  const shared = { ...config, sessions: new SessionRegistry() }
  return {
    alice: createAgentApp(shared, { principal: { id: 'alice' } }),
    bob: createAgentApp(shared, { principal: { id: 'bob' } }),
    sessions: shared.sessions,
  }
}

describe('session ownership', () => {
  it('passes the principal to the agent factory', async () => {
    const agentFactory = vi.fn(() => createMockAgent())
    const { alice } = pair({ agentFactory })
    const { sessionId } = await (await connect(alice)).newSession({ cwd: '/p', mcpServers: [] })

    expect(agentFactory).toHaveBeenCalledWith(sessionId, { cwd: '/p', mcpServers: [] }, { principal: { id: 'alice' } })
  })

  it("ignores a cancel for another caller's session", async () => {
    const agents: Agent[] = []
    const { alice, bob } = pair({
      agentFactory: () => {
        const agent = createMockAgent()
        agents.push(agent)
        return agent
      },
    })
    const { sessionId } = await (await connect(alice)).newSession({ cwd: '/p', mcpServers: [] })
    const bobConn = await connect(bob)

    await bobConn.cancel({ sessionId })
    await bobConn.listSessions({})

    expect(agents[0]!.cancel).not.toHaveBeenCalled()
  })

  it("refuses to load or resume another caller's live session", async () => {
    const { alice, bob } = pair({ agentFactory: () => createMockAgent() })
    const { sessionId } = await (await connect(alice)).newSession({ cwd: '/p', mcpServers: [] })
    const bobConn = await connect(bob)

    await expect(bobConn.loadSession({ sessionId, cwd: '/p', mcpServers: [] })).rejects.toThrow()
    await expect(bobConn.resumeSession({ sessionId, cwd: '/p' })).rejects.toThrow()
  })

  it('records the owner in the store and keeps it from the client', async () => {
    const store = new MemoryStore()
    const { alice, sessions } = pair({ agentFactory: () => createMockAgent(), sessionStore: store })
    const conn = await connect(alice)
    const { sessionId } = await conn.newSession({ cwd: '/p', mcpServers: [] })

    expect(store.records.get(sessionId)?._meta).toEqual({ [OWNER_META_KEY]: 'alice' })
    sessions.delete(sessionId)
    const listed = await conn.listSessions({})
    expect(listed.sessions.map((s) => s.sessionId)).toEqual([sessionId])
    expect(listed.sessions[0]!._meta).toBeUndefined()
  })

  it('loads a stored session only for its owner', async () => {
    const store = new MemoryStore()
    const { alice, bob, sessions } = pair({ agentFactory: () => createMockAgent(), sessionStore: store })
    const aliceConn = await connect(alice)
    const { sessionId } = await aliceConn.newSession({ cwd: '/p', mcpServers: [] })
    sessions.delete(sessionId)
    const bobConn = await connect(bob)

    await expect(bobConn.loadSession({ sessionId, cwd: '/p', mcpServers: [] })).rejects.toThrow()
    expect((await bobConn.listSessions({})).sessions).toEqual([])
    await expect(aliceConn.loadSession({ sessionId, cwd: '/p', mcpServers: [] })).resolves.toEqual({})
  })

  it('refuses a load with a store when the record has no owner', async () => {
    const store = new MemoryStore()
    await store.save({ sessionId: 'abc123', cwd: '/p' })
    const { alice } = pair({ agentFactory: () => createMockAgent(), sessionStore: store })

    await expect((await connect(alice)).loadSession({ sessionId: 'abc123', cwd: '/p', mcpServers: [] })).rejects.toThrow()
  })

  it('fails a load closed when the store cannot be read', async () => {
    const store = new MemoryStore()
    store.list = async () => {
      throw new Error('store down')
    }
    const { alice } = pair({ agentFactory: () => createMockAgent(), sessionStore: store })

    await expect((await connect(alice)).loadSession({ sessionId: 'abc123', cwd: '/p', mcpServers: [] })).rejects.toThrow()
  })
})
