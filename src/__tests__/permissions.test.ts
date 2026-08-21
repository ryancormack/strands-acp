import { describe, it, expect, vi } from 'vitest'
import {
  ClientSideConnection,
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk'
import { AcpAgent, type AcpBridgeConfig } from '../acp-agent.js'
import type { Agent } from '@strands-agents/sdk'
import { resolveDecision, interpretPermissionResponse } from '../permissions.js'

/**
 * A client that answers permission requests with a scripted sequence of option
 * ids and records what it was asked.
 */
class PermissionClient implements Client {
  updates: SessionNotification[] = []
  requests: RequestPermissionRequest[] = []

  constructor(private answers: string[]) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.requests.push(params)
    const optionId = this.answers.shift() ?? 'reject_once'
    if (optionId === 'cancelled') return { outcome: { outcome: 'cancelled' } }
    return { outcome: { outcome: 'selected', optionId } }
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

/**
 * An agent stand-in that reproduces the real event loop's contract around tool
 * calls: it yields the event, then checks `cancel` on resumption and skips the
 * tool if the consumer set it. Mirrors `agent.js` in the Strands SDK, so these
 * tests exercise the actual mechanism the bridge relies on rather than only
 * asserting that the bridge set a field.
 */
function createGatedAgent(
  toolCalls: Array<{ toolUseId: string; name: string; input: unknown }>,
  executed: string[],
): Agent {
  return {
    messages: [],
    stream: async function* () {
      for (const toolUse of toolCalls) {
        const event: Record<string, unknown> = { type: 'beforeToolCallEvent', toolUse }
        yield event as never

        if (event.cancel) {
          const message = typeof event.cancel === 'string' ? event.cancel : 'Tool cancelled by hook'
          yield {
            type: 'afterToolCallEvent',
            toolUse,
            result: { content: [{ type: 'textBlock', text: message }] },
          } as never
          continue
        }

        executed.push(toolUse.name)
        yield {
          type: 'afterToolCallEvent',
          toolUse,
          result: { content: [{ type: 'textBlock', text: 'ok' }] },
        } as never
      }
      return { stopReason: 'endTurn' } as never
    },
    cancel: vi.fn(),
  } as unknown as Agent
}

function connect(config: AcpBridgeConfig, client: PermissionClient) {
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

async function startSession(clientConn: ClientSideConnection) {
  await clientConn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  return clientConn.newSession({ cwd: '/project', mcpServers: [] })
}

describe('resolveDecision', () => {
  const none = new Map()

  it('allows everything when no policy is configured', () => {
    expect(resolveDecision('bash', undefined, none)).toBe('allow')
  })

  it('applies the default to unlisted tools', () => {
    expect(resolveDecision('bash', { default: 'ask' }, none)).toBe('ask')
  })

  it('prefers a per-tool decision over the default', () => {
    expect(resolveDecision('file_read', { default: 'ask', tools: { file_read: 'allow' } }, none)).toBe(
      'allow',
    )
  })

  it('prefers a remembered session decision over configuration', () => {
    const remembered = new Map([['bash', 'allow' as const]])
    expect(resolveDecision('bash', { default: 'deny' }, remembered)).toBe('allow')
  })
})

describe('interpretPermissionResponse', () => {
  it('reads the four option kinds', () => {
    expect(interpretPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_once' } }))
      .toEqual({ allowed: true, cancelled: false })
    expect(interpretPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow_always' } }))
      .toEqual({ allowed: true, remember: 'allow', cancelled: false })
    expect(interpretPermissionResponse({ outcome: { outcome: 'selected', optionId: 'reject_once' } }))
      .toEqual({ allowed: false, cancelled: false })
    expect(interpretPermissionResponse({ outcome: { outcome: 'selected', optionId: 'reject_always' } }))
      .toEqual({ allowed: false, remember: 'deny', cancelled: false })
  })

  it('treats a cancelled turn as not allowed', () => {
    expect(interpretPermissionResponse({ outcome: { outcome: 'cancelled' } })).toEqual({
      allowed: false,
      cancelled: true,
    })
  })

  it('fails closed on an unrecognised option id', () => {
    const outcome = interpretPermissionResponse({
      outcome: { outcome: 'selected', optionId: 'something_else' },
    })
    expect(outcome.allowed).toBe(false)
  })
})

describe('AcpAgent permission gating', () => {
  it('does not ask when no policy is configured', async () => {
    const executed: string[] = []
    const client = new PermissionClient([])
    const clientConn = connect(
      { agentFactory: () => createGatedAgent([{ toolUseId: 't1', name: 'bash', input: {} }], executed) },
      client,
    )

    const { sessionId } = await startSession(clientConn)
    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(client.requests).toHaveLength(0)
    expect(executed).toEqual(['bash'])
  })

  it('asks before running a gated tool and runs it when allowed', async () => {
    const executed: string[] = []
    const client = new PermissionClient(['allow_once'])
    const clientConn = connect(
      {
        agentFactory: () =>
          createGatedAgent([{ toolUseId: 't1', name: 'file_write', input: { path: '/a.ts' } }], executed),
        permissions: { default: 'ask' },
      },
      client,
    )

    const { sessionId } = await startSession(clientConn)
    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(client.requests).toHaveLength(1)
    expect(client.requests[0].toolCall.title).toBe('file_write')
    expect(client.requests[0].toolCall.kind).toBe('edit')
    expect(client.requests[0].toolCall.locations).toEqual([{ path: '/a.ts' }])
    expect(client.requests[0].options.map((o) => o.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ])
    expect(executed).toEqual(['file_write'])
  })

  it('prevents the tool from running when rejected', async () => {
    const executed: string[] = []
    const client = new PermissionClient(['reject_once'])
    const clientConn = connect(
      {
        agentFactory: () =>
          createGatedAgent([{ toolUseId: 't1', name: 'delete_file', input: { path: '/a.ts' } }], executed),
        permissions: { default: 'ask' },
      },
      client,
    )

    const { sessionId } = await startSession(clientConn)
    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    // The point of the whole feature: the tool did not run.
    expect(executed).toEqual([])
    const failed = client.updates.filter((u) => (u.update as never as { status?: string }).status === 'failed')
    expect(failed.length).toBeGreaterThan(0)
  })

  it('asks once when the user says always allow', async () => {
    const executed: string[] = []
    const client = new PermissionClient(['allow_always'])
    const clientConn = connect(
      {
        agentFactory: () =>
          createGatedAgent(
            [
              { toolUseId: 't1', name: 'bash', input: {} },
              { toolUseId: 't2', name: 'bash', input: {} },
              { toolUseId: 't3', name: 'bash', input: {} },
            ],
            executed,
          ),
        permissions: { default: 'ask' },
      },
      client,
    )

    const { sessionId } = await startSession(clientConn)
    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(client.requests).toHaveLength(1)
    expect(executed).toEqual(['bash', 'bash', 'bash'])
  })

  it('stops asking after the user says always reject', async () => {
    const executed: string[] = []
    const client = new PermissionClient(['reject_always'])
    const clientConn = connect(
      {
        agentFactory: () =>
          createGatedAgent(
            [
              { toolUseId: 't1', name: 'bash', input: {} },
              { toolUseId: 't2', name: 'bash', input: {} },
            ],
            executed,
          ),
        permissions: { default: 'ask' },
      },
      client,
    )

    const { sessionId } = await startSession(clientConn)
    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(client.requests).toHaveLength(1)
    expect(executed).toEqual([])
  })

  it('denies a policy-denied tool without asking the client', async () => {
    const executed: string[] = []
    const client = new PermissionClient([])
    const clientConn = connect(
      {
        agentFactory: () =>
          createGatedAgent([{ toolUseId: 't1', name: 'rm', input: {} }], executed),
        permissions: { default: 'allow', tools: { rm: 'deny' } },
      },
      client,
    )

    const { sessionId } = await startSession(clientConn)
    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(client.requests).toHaveLength(0)
    expect(executed).toEqual([])
  })

  it('reports a cancelled permission request as a cancelled turn', async () => {
    const executed: string[] = []
    const client = new PermissionClient(['cancelled'])
    const clientConn = connect(
      {
        agentFactory: () =>
          createGatedAgent([{ toolUseId: 't1', name: 'bash', input: {} }], executed),
        permissions: { default: 'ask' },
      },
      client,
    )

    const { sessionId } = await startSession(clientConn)
    const response = await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(response.stopReason).toBe('cancelled')
    expect(executed).toEqual([])
  })

  it('gates only the tools the policy names', async () => {
    const executed: string[] = []
    const client = new PermissionClient(['allow_once'])
    const clientConn = connect(
      {
        agentFactory: () =>
          createGatedAgent(
            [
              { toolUseId: 't1', name: 'file_read', input: { path: '/a' } },
              { toolUseId: 't2', name: 'bash', input: {} },
            ],
            executed,
          ),
        permissions: { default: 'allow', tools: { bash: 'ask' } },
      },
      client,
    )

    const { sessionId } = await startSession(clientConn)
    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(client.requests).toHaveLength(1)
    expect(client.requests[0].toolCall.title).toBe('bash')
    expect(executed).toEqual(['file_read', 'bash'])
  })

  it('sends exactly one tool_call per invocation when the stream already announced it', async () => {
    // The model stream announces a tool call as soon as it starts, before the
    // parsed input exists. The permission gate then runs. ACP expects one
    // tool_call followed by tool_call_updates, so the gate must not announce
    // the same toolCallId a second time.
    const executed: string[] = []
    const client = new PermissionClient(['allow_once'])
    const toolUse = { toolUseId: 'dup-1', name: 'bash', input: { cmd: 'ls' } }

    const agent = {
      messages: [],
      stream: async function* () {
        // Stream start: the bridge announces the call with empty input.
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', name: toolUse.name, toolUseId: toolUse.toolUseId },
          },
        } as never
        // Then the hook fires, carrying the real input, and the gate runs.
        const event: Record<string, unknown> = { type: 'beforeToolCallEvent', toolUse }
        yield event as never
        if (!event.cancel) executed.push(toolUse.name)
        yield {
          type: 'afterToolCallEvent',
          toolUse,
          result: { content: [{ type: 'textBlock', text: 'ok' }] },
        } as never
        return { stopReason: 'endTurn' } as never
      },
      cancel: vi.fn(),
    } as unknown as Agent

    const clientConn = connect({ agentFactory: () => agent, permissions: { default: 'ask' } }, client)
    const { sessionId } = await startSession(clientConn)
    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    const announces = client.updates.filter(
      (u) => (u.update as never as { sessionUpdate?: string }).sessionUpdate === 'tool_call',
    )
    expect(announces).toHaveLength(1)
    expect(executed).toEqual(['bash'])

    // The gate's pending state still reaches the client, as an update.
    const pending = client.updates.filter(
      (u) => (u.update as never as { status?: string }).status === 'pending',
    )
    expect(pending.length).toBeGreaterThan(0)
    expect(
      (pending[0].update as never as { sessionUpdate?: string }).sessionUpdate,
    ).toBe('tool_call_update')
  })

  it('sends one tool_call when the stream did not announce first', async () => {
    // Without a preceding stream announcement the gate owns the first
    // notification, so it must still be a tool_call.
    const executed: string[] = []
    const client = new PermissionClient(['allow_once'])
    const clientConn = connect(
      {
        agentFactory: () =>
          createGatedAgent([{ toolUseId: 't1', name: 'bash', input: {} }], executed),
        permissions: { default: 'ask' },
      },
      client,
    )
    const { sessionId } = await startSession(clientConn)
    await clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    const announces = client.updates.filter(
      (u) => (u.update as never as { sessionUpdate?: string }).sessionUpdate === 'tool_call',
    )
    expect(announces).toHaveLength(1)
    expect(executed).toEqual(['bash'])
  })

})
