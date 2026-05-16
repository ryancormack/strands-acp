import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import {
  ClientSideConnection,
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { AcpAgent } from '../acp-agent.js'
import type { Agent } from '@strands-agents/sdk'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class TestClient implements Client {
  updates: SessionNotification[] = []

  async requestPermission() {
    return { outcome: { outcome: 'selected' as const, optionId: 'allow' } }
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

function createMockAgent(
  events: Array<Record<string, unknown>> = [],
  result: Record<string, unknown> = { stopReason: 'endTurn' },
): Agent {
  return {
    stream: async function* (_text: string) {
      for (const event of events) {
        yield event as any
      }
      return result as any
    },
    cancel: vi.fn(),
  } as unknown as Agent
}

/**
 * Creates a pair of connected client/agent connections using in-process
 * TransformStream pairs, matching the pattern from the ACP SDK test suite.
 */
function createConnectionPair(
  agentFactory: (sessionId: string) => Agent,
  testClient?: TestClient,
): {
  clientConn: ClientSideConnection
  agentConn: AgentSideConnection
  client: TestClient
} {
  const clientToAgent = new TransformStream()
  const agentToClient = new TransformStream()
  const client = testClient ?? new TestClient()

  const clientConn = new ClientSideConnection(
    () => client,
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  )
  const agentConn = new AgentSideConnection(
    (conn) => new AcpAgent(conn, agentFactory),
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  )

  return { clientConn, agentConn, client }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpAgent', () => {
  let mockAgent: Agent
  let agentFactory: (sessionId: string) => Agent

  beforeEach(() => {
    mockAgent = createMockAgent()
    agentFactory = (_sessionId: string) => mockAgent
  })

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  it('initialization returns protocol version and capabilities', async () => {
    const { clientConn } = createConnectionPair(agentFactory)

    const response = await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(response.agentCapabilities?.loadSession).toBe(true)
    expect(response.agentCapabilities?.sessionCapabilities?.close).toEqual({})
    expect(response.agentCapabilities?.sessionCapabilities?.list).toEqual({})
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({})
    expect(response.agentInfo?.name).toBe('strands-acp-agent')
  })

  // -----------------------------------------------------------------------
  // Session creation
  // -----------------------------------------------------------------------

  it('newSession creates a session with valid sessionId', async () => {
    const { clientConn } = createConnectionPair(agentFactory)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    expect(session.sessionId).toBeDefined()
    expect(session.sessionId).toMatch(/^[0-9a-f]{32}$/)
  })

  // -----------------------------------------------------------------------
  // Prompt - text streaming
  // -----------------------------------------------------------------------

  it('prompt streams text responses via session updates', async () => {
    const textEvents = [
      {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: 'Hello' },
        },
      },
      {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: ' World' },
        },
      },
    ]

    const agent = createMockAgent(textEvents)
    const client = new TestClient()
    const { clientConn } = createConnectionPair((_sessionId: string) => agent, client)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    const result = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Say hello' }],
    })

    expect(result.stopReason).toBe('end_turn')

    // Wait briefly for async notifications to arrive
    await vi.waitFor(() => {
      const textUpdates = client.updates.filter(
        (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'agent_message_chunk',
      )
      expect(textUpdates).toHaveLength(2)
    })

    const textUpdates = client.updates.filter(
      (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'agent_message_chunk',
    )
    expect((textUpdates[0].update as any).content.text).toBe('Hello')
    expect((textUpdates[1].update as any).content.text).toBe(' World')
  })

  // -----------------------------------------------------------------------
  // Prompt - tool calls
  // -----------------------------------------------------------------------

  it('prompt handles tool call events', async () => {
    const toolEvents = [
      {
        type: 'beforeToolCallEvent',
        toolUse: { toolUseId: 'tool-1', name: 'myTool', input: {} },
      },
      {
        type: 'afterToolCallEvent',
        toolUse: { toolUseId: 'tool-1', name: 'myTool', input: {} },
      },
    ]

    const agent = createMockAgent(toolEvents)
    const client = new TestClient()
    const { clientConn } = createConnectionPair((_sessionId: string) => agent, client)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Use a tool' }],
    })

    await vi.waitFor(() => {
      const toolCalls = client.updates.filter(
        (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call',
      )
      const toolUpdates = client.updates.filter(
        (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call_update',
      )
      expect(toolCalls).toHaveLength(1)
      expect(toolUpdates).toHaveLength(1)
    })

    const toolCall = client.updates.find(
      (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call',
    )
    expect((toolCall!.update as any).toolCallId).toBe('tool-1')
    expect((toolCall!.update as any).title).toBe('myTool')
    expect((toolCall!.update as any).status).toBe('in_progress')

    const toolUpdate = client.updates.find(
      (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call_update',
    )
    expect((toolUpdate!.update as any).toolCallId).toBe('tool-1')
    expect((toolUpdate!.update as any).status).toBe('completed')
  })

  // -----------------------------------------------------------------------
  // Cancel
  // -----------------------------------------------------------------------

  it('cancel aborts in-progress prompt', async () => {
    // Create a mock agent whose stream yields events slowly
    let resolveBlock: (() => void) | undefined
    const blockPromise = new Promise<void>((r) => {
      resolveBlock = r
    })

    const slowAgent = {
      stream: async function* (_text: string) {
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'partial' },
          },
        } as any
        // Block until cancelled or resolved
        await blockPromise
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'more' },
          },
        } as any
        return { stopReason: 'endTurn' } as any
      },
      cancel: vi.fn(),
    } as unknown as Agent

    const client = new TestClient()
    const { clientConn } = createConnectionPair((_sessionId: string) => slowAgent, client)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    // Start prompt but don't await - we need to cancel it
    const promptPromise = clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Be slow' }],
    })

    // Give time for the stream to start and yield the first event
    await new Promise((r) => setTimeout(r, 100))

    // Cancel the session
    await clientConn.cancel({ sessionId: session.sessionId })

    // Unblock the stream so the generator can finish
    resolveBlock!()

    const result = await promptPromise
    expect(result.stopReason).toBe('cancelled')
  })

  // -----------------------------------------------------------------------
  // Close session
  // -----------------------------------------------------------------------

  it('closeSession removes session and rejects further prompts', async () => {
    const { clientConn } = createConnectionPair(agentFactory)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    await clientConn.closeSession({ sessionId: session.sessionId })

    // Prompting the closed session should throw
    await expect(
      clientConn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Hello' }],
      }),
    ).rejects.toThrow()
  })

  // -----------------------------------------------------------------------
  // List sessions
  // -----------------------------------------------------------------------

  it('listSessions returns all sessions with metadata', async () => {
    const { clientConn } = createConnectionPair(agentFactory)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const s1 = await clientConn.newSession({ cwd: '/project-a', mcpServers: [] })
    const s2 = await clientConn.newSession({ cwd: '/project-b', mcpServers: [] })
    const s3 = await clientConn.newSession({ cwd: '/project-a', mcpServers: [] })

    // List all sessions
    const allSessions = await clientConn.listSessions({})
    expect(allSessions.sessions).toHaveLength(3)

    const sessionIds = allSessions.sessions.map((s: { sessionId: string }) => s.sessionId)
    expect(sessionIds).toContain(s1.sessionId)
    expect(sessionIds).toContain(s2.sessionId)
    expect(sessionIds).toContain(s3.sessionId)

    // Filter by cwd
    const filteredSessions = await clientConn.listSessions({ cwd: '/project-a' })
    expect(filteredSessions.sessions).toHaveLength(2)

    const filteredIds = filteredSessions.sessions.map((s: { sessionId: string }) => s.sessionId)
    expect(filteredIds).toContain(s1.sessionId)
    expect(filteredIds).toContain(s3.sessionId)
    expect(filteredIds).not.toContain(s2.sessionId)
  })

  // -----------------------------------------------------------------------
  // Resume session
  // -----------------------------------------------------------------------

  it('resumeSession reconnects to existing session', async () => {
    const { clientConn } = createConnectionPair(agentFactory)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    // Resume should succeed for an existing session
    const result = await clientConn.resumeSession({ sessionId: session.sessionId, cwd: '/test' })
    expect(result).toBeDefined()

    // Resume with a non-existent session should throw
    await expect(
      clientConn.resumeSession({ sessionId: 'nonexistent-session-id', cwd: '/test' }),
    ).rejects.toThrow()
  })

  // -----------------------------------------------------------------------
  // Error handling - unknown session
  // -----------------------------------------------------------------------

  it('prompt to unknown session returns error', async () => {
    const { clientConn } = createConnectionPair(agentFactory)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    await expect(
      clientConn.prompt({
        sessionId: 'does-not-exist',
        prompt: [{ type: 'text', text: 'Hello' }],
      }),
    ).rejects.toThrow()
  })

  // -----------------------------------------------------------------------
  // Multiple sessions - independent contexts
  // -----------------------------------------------------------------------

  it('multiple sessions maintain independent contexts', async () => {
    const streamCallTexts: string[] = []

    const factory = (_sessionId: string) => {
      return {
        stream: async function* (text: string) {
          streamCallTexts.push(text)
          yield {
            type: 'modelStreamUpdateEvent',
            event: {
              type: 'modelContentBlockDeltaEvent',
              delta: { type: 'textDelta', text: `echo: ${text}` },
            },
          } as any
          return { stopReason: 'endTurn' } as any
        },
        cancel: vi.fn(),
      } as unknown as Agent
    }

    const client = new TestClient()
    const { clientConn } = createConnectionPair(factory, client)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const s1 = await clientConn.newSession({ cwd: '/a', mcpServers: [] })
    const s2 = await clientConn.newSession({ cwd: '/b', mcpServers: [] })

    await clientConn.prompt({
      sessionId: s1.sessionId,
      prompt: [{ type: 'text', text: 'message-for-session-1' }],
    })

    await clientConn.prompt({
      sessionId: s2.sessionId,
      prompt: [{ type: 'text', text: 'message-for-session-2' }],
    })

    expect(streamCallTexts).toContain('message-for-session-1')
    expect(streamCallTexts).toContain('message-for-session-2')

    // Verify both sessions are still active
    const sessions = await clientConn.listSessions({})
    expect(sessions.sessions).toHaveLength(2)
  })

  // -----------------------------------------------------------------------
  // Tool call via modelStreamUpdateEvent (toolUseStart)
  // -----------------------------------------------------------------------

  it('prompt handles tool start via model stream event', async () => {
    const toolStreamEvents = [
      {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', toolUseId: 'stream-tool-1', name: 'streamTool' },
        },
      },
    ]

    const agent = createMockAgent(toolStreamEvents)
    const client = new TestClient()
    const { clientConn } = createConnectionPair((_sessionId: string) => agent, client)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Use stream tool' }],
    })

    await vi.waitFor(() => {
      const toolCalls = client.updates.filter(
        (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call',
      )
      expect(toolCalls).toHaveLength(1)
    })

    const toolCall = client.updates.find(
      (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call',
    )
    expect((toolCall!.update as any).toolCallId).toBe('stream-tool-1')
    expect((toolCall!.update as any).title).toBe('streamTool')
  })

  // -----------------------------------------------------------------------
  // Duplicate tool_call deduplication
  // -----------------------------------------------------------------------

  it('deduplicates tool_call when both modelContentBlockStartEvent and beforeToolCallEvent fire', async () => {
    const duplicateToolEvents = [
      {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', toolUseId: 'dup-tool-1', name: 'dupTool' },
        },
      },
      {
        type: 'beforeToolCallEvent',
        toolUse: { toolUseId: 'dup-tool-1', name: 'dupTool', input: { key: 'value' } },
      },
      {
        type: 'afterToolCallEvent',
        toolUse: { toolUseId: 'dup-tool-1', name: 'dupTool', input: { key: 'value' } },
      },
    ]

    const agent = createMockAgent(duplicateToolEvents)
    const client = new TestClient()
    const { clientConn } = createConnectionPair((_sessionId: string) => agent, client)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Trigger duplicate' }],
    })

    await vi.waitFor(() => {
      const toolUpdates = client.updates.filter(
        (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call_update',
      )
      expect(toolUpdates).toHaveLength(2)
    })

    // Only one tool_call notification should be emitted, not two
    const toolCalls = client.updates.filter(
      (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call',
    )
    expect(toolCalls).toHaveLength(1)
    expect((toolCalls[0].update as any).toolCallId).toBe('dup-tool-1')

    // The first tool_call_update carries the rawInput from beforeToolCallEvent
    const toolUpdates = client.updates.filter(
      (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call_update',
    )
    expect((toolUpdates[0].update as any).rawInput).toEqual({ key: 'value' })
    expect((toolUpdates[1].update as any).status).toBe('completed')
  })

  // -----------------------------------------------------------------------
  // cwd filter with trailing slash normalization
  // -----------------------------------------------------------------------

  it('listSessions matches cwd with trailing slash normalization', async () => {
    const { clientConn } = createConnectionPair(agentFactory)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    await clientConn.newSession({ cwd: '/project-a', mcpServers: [] })
    await clientConn.newSession({ cwd: '/project-b/', mcpServers: [] })

    // Filter with trailing slash should match session without trailing slash
    const filtered1 = await clientConn.listSessions({ cwd: '/project-a/' })
    expect(filtered1.sessions).toHaveLength(1)

    // Filter without trailing slash should match session with trailing slash
    const filtered2 = await clientConn.listSessions({ cwd: '/project-b' })
    expect(filtered2.sessions).toHaveLength(1)
  })

  // -----------------------------------------------------------------------
  // updatedAt advances after prompt
  // -----------------------------------------------------------------------

  it('listSessions updatedAt advances after a prompt', async () => {
    const textEvents = [
      {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: 'hi' },
        },
      },
    ]

    const agent = createMockAgent(textEvents)
    const client = new TestClient()
    const { clientConn } = createConnectionPair((_sessionId: string) => agent, client)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    const beforePrompt = await clientConn.listSessions({})
    const updatedAtBefore = beforePrompt.sessions[0].updatedAt

    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 10))

    await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    })

    const afterPrompt = await clientConn.listSessions({})
    const updatedAtAfter = afterPrompt.sessions[0].updatedAt

    expect(new Date(updatedAtAfter!).getTime()).toBeGreaterThan(new Date(updatedAtBefore!).getTime())
  })

  // -----------------------------------------------------------------------
  // stopReason mapping
  // -----------------------------------------------------------------------

  it('prompt maps Strands maxTokens to ACP max_tokens', async () => {
    const agent = createMockAgent([], { stopReason: 'maxTokens' })
    const { clientConn } = createConnectionPair((_sessionId: string) => agent)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    const result = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Hello' }],
    })

    expect(result.stopReason).toBe('max_tokens')
  })

  it('prompt maps Strands contentFiltered to ACP refusal', async () => {
    const agent = createMockAgent([], { stopReason: 'contentFiltered' })
    const { clientConn } = createConnectionPair((_sessionId: string) => agent)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    const result = await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Hello' }],
    })

    expect(result.stopReason).toBe('refusal')
  })

  // -----------------------------------------------------------------------
  // resumeSession creates new agent with same sessionId
  // -----------------------------------------------------------------------

  it('resumeSession creates a new agent with the same session ID', async () => {
    const factory = vi.fn((_sessionId: string) => createMockAgent())
    const { clientConn } = createConnectionPair(factory)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    await clientConn.resumeSession({ sessionId: session.sessionId, cwd: '/test' })

    // Factory should be called twice: once for newSession, once for resumeSession
    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenNthCalledWith(1, session.sessionId)
    expect(factory).toHaveBeenNthCalledWith(2, session.sessionId)
  })

  // -----------------------------------------------------------------------
  // loadSession - streams conversation history
  // -----------------------------------------------------------------------

  it('loadSession restores session and streams history back', async () => {
    const factory = (_sessionId: string) => {
      const agent = createMockAgent()
      // Simulate restored messages
      ;(agent as any).messages = [
        { role: 'user', content: [{ type: 'textBlock', text: 'Hello' }] },
        { role: 'assistant', content: [{ type: 'textBlock', text: 'Hi there!' }] },
      ]
      return agent
    }

    const client = new TestClient()
    const { clientConn } = createConnectionPair(factory, client)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    await clientConn.loadSession({
      sessionId: 'existing-session-123',
      cwd: '/test',
      mcpServers: [],
    })

    await vi.waitFor(() => {
      expect(client.updates).toHaveLength(2)
    })

    expect((client.updates[0].update as any).sessionUpdate).toBe('user_message_chunk')
    expect((client.updates[0].update as any).content.text).toBe('Hello')
    expect((client.updates[1].update as any).sessionUpdate).toBe('agent_message_chunk')
    expect((client.updates[1].update as any).content.text).toBe('Hi there!')
  })

  // -----------------------------------------------------------------------
  // rawInput forwarding in tool_call
  // -----------------------------------------------------------------------

  it('prompt forwards structured tool input as rawInput', async () => {
    const toolInput = { file_path: '/src/main.ts', content: 'hello' }
    const toolEvents = [
      {
        type: 'beforeToolCallEvent',
        toolUse: { toolUseId: 'tool-input-1', name: 'writeFile', input: toolInput },
      },
      {
        type: 'afterToolCallEvent',
        toolUse: { toolUseId: 'tool-input-1', name: 'writeFile', input: toolInput },
      },
    ]

    const agent = createMockAgent(toolEvents)
    const client = new TestClient()
    const { clientConn } = createConnectionPair((_sessionId: string) => agent, client)

    await clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    const session = await clientConn.newSession({
      cwd: '/test',
      mcpServers: [],
    })

    await clientConn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Write a file' }],
    })

    await vi.waitFor(() => {
      const toolCalls = client.updates.filter(
        (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call',
      )
      expect(toolCalls).toHaveLength(1)
    })

    const toolCall = client.updates.find(
      (u) => u.update && 'sessionUpdate' in u.update && u.update.sessionUpdate === 'tool_call',
    )
    expect((toolCall!.update as any).rawInput).toEqual(toolInput)
  })
})
