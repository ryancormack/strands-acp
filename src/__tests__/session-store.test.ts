import { describe, it, expect, vi } from 'vitest'
import {
  ClientSideConnection,
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionNotification,
  type SessionInfo,
} from '@agentclientprotocol/sdk'
import { AcpAgent, type AcpBridgeConfig } from '../acp-agent.js'
import type { Agent } from '@strands-agents/sdk'
import { mergeSessionInfos, deriveTitle, type SessionStore } from '../session-store.js'

const info = (
  sessionId: string,
  cwd: string,
  updatedAt: string | null,
  title: string | null = null,
): SessionInfo => ({ sessionId, cwd, updatedAt, title })

class QuietClient implements Client {
  updates: SessionNotification[] = []
  async requestPermission() {
    return { outcome: { outcome: 'selected' as const, optionId: 'allow_once' } }
  }
  async sessionUpdate(params: SessionNotification) {
    this.updates.push(params)
  }
  async writeTextFile() {
    return {}
  }
  async readTextFile() {
    return { content: '' }
  }
}

function createMockAgent(): Agent {
  return {
    // `messages` is what loadSession's history replay walks.
    messages: [],
    stream: async function* (_text: string) {
      return { stopReason: 'endTurn' } as any
    },
    cancel: vi.fn(),
  } as unknown as Agent
}

function connect(config: AcpBridgeConfig, client: Client) {
  const clientToAgent = new TransformStream()
  const agentToClient = new TransformStream()
  const clientConn = new ClientSideConnection(
    () => client,
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  )
  new AgentSideConnection(
    (conn) => new AcpAgent(conn, config),
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  )
  return clientConn
}

async function init(clientConn: ClientSideConnection) {
  await clientConn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
}

/** A store backed by a Map, standing in for a caller's real persistence. */
class MemoryStore implements SessionStore {
  saved = new Map<string, SessionInfo>()
  listCalls = 0

  constructor(seed: SessionInfo[] = []) {
    for (const entry of seed) this.saved.set(entry.sessionId, entry)
  }
  async list(params: { cwd?: string | null }): Promise<SessionInfo[]> {
    this.listCalls++
    const all = [...this.saved.values()]
    return params.cwd ? all.filter((s) => s.cwd === params.cwd) : all
  }
  async save(entry: SessionInfo): Promise<void> {
    this.saved.set(entry.sessionId, entry)
  }
}

describe('mergeSessionInfos', () => {
  it('prefers the live entry when a session is both live and stored', () => {
    const live = [info('a', '/project', '2026-08-21T10:00:00.000Z', 'live title')]
    const stored = [info('a', '/stale', '2026-01-01T00:00:00.000Z', 'stored title')]

    const merged = mergeSessionInfos(live, stored)

    expect(merged).toHaveLength(1)
    expect(merged[0]!.title).toBe('live title')
    expect(merged[0]!.cwd).toBe('/project')
  })

  it('includes stored sessions the running process never created', () => {
    const live = [info('a', '/project', '2026-08-21T10:00:00.000Z')]
    const stored = [info('b', '/project', '2026-08-20T10:00:00.000Z')]

    expect(mergeSessionInfos(live, stored).map((s) => s.sessionId)).toEqual(['a', 'b'])
  })

  it('filters stored entries by cwd even when the store ignored the hint', () => {
    const stored = [info('a', '/project', '2026-08-21T10:00:00.000Z'), info('b', '/other', '2026-08-21T11:00:00.000Z')]

    const merged = mergeSessionInfos([], stored, '/project')

    expect(merged.map((s) => s.sessionId)).toEqual(['a'])
  })

  it('treats a trailing slash on cwd as the same directory', () => {
    const stored = [info('a', '/project', '2026-08-21T10:00:00.000Z')]

    expect(mergeSessionInfos([], stored, '/project/')).toHaveLength(1)
  })

  it('sorts most recently updated first', () => {
    const stored = [
      info('old', '/p', '2026-01-01T00:00:00.000Z'),
      info('new', '/p', '2026-08-21T00:00:00.000Z'),
      info('mid', '/p', '2026-05-01T00:00:00.000Z'),
    ]

    expect(mergeSessionInfos([], stored).map((s) => s.sessionId)).toEqual(['new', 'mid', 'old'])
  })

  it('sorts an entry with no timestamp last rather than first', () => {
    const stored = [info('undated', '/p', null), info('dated', '/p', '2026-01-01T00:00:00.000Z')]

    expect(mergeSessionInfos([], stored).map((s) => s.sessionId)).toEqual(['dated', 'undated'])
  })
})

describe('deriveTitle', () => {
  it('uses the first text block', () => {
    expect(deriveTitle([{ type: 'text', text: 'Help me write a STAR answer' }])).toBe(
      'Help me write a STAR answer',
    )
  })

  it('collapses whitespace and newlines', () => {
    expect(deriveTitle([{ type: 'text', text: '  Review\n\n  my   answer  ' }])).toBe('Review my answer')
  })

  it('truncates at a word boundary', () => {
    const long =
      'Please help me prepare a full STAR answer for the deliver results leadership principle interview'
    const title = deriveTitle([{ type: 'text', text: long }])

    expect(title!.endsWith('…')).toBe(true)
    expect(title!.length).toBeLessThanOrEqual(61)
    // Cut on a space, so the last word is never left as a fragment.
    expect(title!.slice(0, -1).endsWith(' ')).toBe(false)
    expect(long.startsWith(title!.slice(0, -1))).toBe(true)
  })

  it('hard-cuts rather than collapsing to nothing when the first word is enormous', () => {
    const title = deriveTitle([{ type: 'text', text: 'x'.repeat(200) }])

    expect(title).toBe(`${'x'.repeat(60)}…`)
  })

  it('skips blank text blocks', () => {
    expect(deriveTitle([{ type: 'text', text: '   ' }, { type: 'text', text: 'real' }])).toBe('real')
  })

  it('returns null when the prompt carries no text', () => {
    expect(deriveTitle([{ type: 'image', mimeType: 'image/png', data: 'abc' }])).toBeNull()
  })
})

describe('listSessions with a store', () => {
  it('reports only live sessions when no store is configured', async () => {
    const clientConn = connect({ agentFactory: () => createMockAgent() }, new QuietClient())
    await init(clientConn)
    const { sessionId } = await clientConn.newSession({ cwd: '/project', mcpServers: [] })

    const { sessions } = await clientConn.listSessions({})

    expect(sessions.map((s) => s.sessionId)).toEqual([sessionId])
  })

  it('surfaces a stored session this process never created', async () => {
    const store = new MemoryStore([info('from-disk', '/project', '2026-01-01T00:00:00.000Z', 'yesterday')])
    const clientConn = connect(
      { agentFactory: () => createMockAgent(), sessionStore: store },
      new QuietClient(),
    )
    await init(clientConn)
    const { sessionId } = await clientConn.newSession({ cwd: '/project', mcpServers: [] })

    const { sessions } = await clientConn.listSessions({})

    // The live session is newer, so it sorts first; the disk one is still there.
    expect(sessions.map((s) => s.sessionId)).toEqual([sessionId, 'from-disk'])
    expect(sessions[1]!.title).toBe('yesterday')
  })

  it('records a new session in the store so a later process can list it', async () => {
    const store = new MemoryStore()
    const clientConn = connect(
      { agentFactory: () => createMockAgent(), sessionStore: store },
      new QuietClient(),
    )
    await init(clientConn)
    const { sessionId } = await clientConn.newSession({ cwd: '/project', mcpServers: [] })

    expect(store.saved.has(sessionId)).toBe(true)
    expect(store.saved.get(sessionId)!.cwd).toBe('/project')
  })

  it('stores a title derived from the first prompt', async () => {
    const store = new MemoryStore()
    const clientConn = connect(
      { agentFactory: () => createMockAgent(), sessionStore: store },
      new QuietClient(),
    )
    await init(clientConn)
    const { sessionId } = await clientConn.newSession({ cwd: '/project', mcpServers: [] })

    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'Prep me for an interview' }] })

    expect(store.saved.get(sessionId)!.title).toBe('Prep me for an interview')
  })

  it('keeps the first prompt as the title rather than the latest', async () => {
    const store = new MemoryStore()
    const clientConn = connect(
      { agentFactory: () => createMockAgent(), sessionStore: store },
      new QuietClient(),
    )
    await init(clientConn)
    const { sessionId } = await clientConn.newSession({ cwd: '/project', mcpServers: [] })

    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'second' }] })

    expect(store.saved.get(sessionId)!.title).toBe('first')
  })

  it('does not fail a turn when the store write throws', async () => {
    const store = new MemoryStore()
    store.save = async () => {
      throw new Error('disk full')
    }
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const clientConn = connect(
      { agentFactory: () => createMockAgent(), sessionStore: store },
      new QuietClient(),
    )
    await init(clientConn)

    const { sessionId } = await clientConn.newSession({ cwd: '/project', mcpServers: [] })
    const result = await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] })

    expect(result.stopReason).toBe('end_turn')
    expect(stderr).toHaveBeenCalled()
    stderr.mockRestore()
  })

  it('fails the list call when the store read throws, rather than reporting no sessions', async () => {
    const store = new MemoryStore()
    store.list = async () => {
      throw new Error('backend unreachable')
    }
    const clientConn = connect(
      { agentFactory: () => createMockAgent(), sessionStore: store },
      new QuietClient(),
    )
    await init(clientConn)
    await clientConn.newSession({ cwd: '/project', mcpServers: [] })

    // Degrading to the live-only list would look authoritative and be wrong.
    await expect(clientConn.listSessions({})).rejects.toThrow()
  })

  it('restores a stored title when a session is loaded', async () => {
    const store = new MemoryStore([info('resumed', '/project', '2026-01-01T00:00:00.000Z', 'earlier work')])
    const clientConn = connect(
      { agentFactory: () => createMockAgent(), sessionStore: store },
      new QuietClient(),
    )
    await init(clientConn)

    await clientConn.loadSession({ sessionId: 'resumed', cwd: '/project', mcpServers: [] })
    const { sessions } = await clientConn.listSessions({})

    const loaded = sessions.find((s) => s.sessionId === 'resumed')
    expect(loaded!.title).toBe('earlier work')
  })
})
