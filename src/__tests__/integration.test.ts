import { describe, it, expect } from 'vitest'
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
import { Agent, Model, tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { AcpAgent, type AcpBridgeConfig } from '../acp-agent.js'

/**
 * Integration tests that drive a **real** Strands `Agent` — real event loop, real
 * tool execution, real hook events — over a **real** ACP JSON-RPC connection.
 *
 * The rest of the suite mocks the agent, which means it can only prove the bridge
 * emits what we think it should. These tests prove the part that actually matters
 * and that a mock cannot: that setting `BeforeToolCallEvent.cancel` while the
 * agent is suspended at its yield genuinely stops the tool from running. If that
 * assumption about the SDK is wrong, these fail.
 *
 * Only the model is stubbed, because a model is a pluggable interface and calling
 * a real one would need network and a key. The event sequence it emits mirrors the
 * SDK's own `MockMessageModel` fixture.
 */

/** A model that replays scripted turns without any network call. */
class StubModel extends Model {
  private turnIndex = 0
  private config = {}

  constructor(private turns: Array<{ toolUse?: { name: string; toolUseId: string; input: unknown }; text?: string }>) {
    super()
  }

  updateConfig(modelConfig: Record<string, unknown>): void {
    this.config = { ...this.config, ...modelConfig }
  }

  getConfig() {
    return this.config
  }

  async *stream(): AsyncGenerator<Record<string, unknown>> {
    // Reuse the final turn if the loop asks for more than were scripted.
    const turn = this.turns[Math.min(this.turnIndex, this.turns.length - 1)]
    this.turnIndex += 1

    yield { type: 'modelMessageStartEvent', role: 'assistant' }

    if (turn.toolUse) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: turn.toolUse.name, toolUseId: turn.toolUse.toolUseId },
      }
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(turn.toolUse.input) },
      }
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
      return
    }

    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: turn.text ?? 'done' } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}

class ScriptedClient implements Client {
  updates: SessionNotification[] = []
  requests: RequestPermissionRequest[] = []

  constructor(private answers: string[]) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.requests.push(params)
    const optionId = this.answers.shift() ?? 'reject_once'
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
 * Builds a real Agent with one recording tool, wired through the real bridge and
 * a real ACP connection pair.
 */
function buildHarness(answers: string[], permissions?: AcpBridgeConfig['permissions']) {
  const sideEffects: string[] = []

  const writeFile = tool({
    name: 'write_file',
    description: 'Writes a file.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    callback: ({ path }) => {
      // Stands in for the real side effect. If permission gating works, a
      // rejected call never reaches this line.
      sideEffects.push(path)
      return { written: path }
    },
  })

  const client = new ScriptedClient(answers)
  const clientToAgent = new TransformStream()
  const agentToClient = new TransformStream()

  const clientConn = new ClientSideConnection(
    () => client,
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  )

  new AgentSideConnection(
    (conn) =>
      new AcpAgent(conn, {
        agentFactory: () =>
          new Agent({
            model: new StubModel([
              { toolUse: { name: 'write_file', toolUseId: 'call-1', input: { path: '/tmp/a.txt', content: 'hi' } } },
              { text: 'all done' },
            ]) as unknown as ConstructorParameters<typeof Agent>[0]['model'],
            tools: [writeFile],
          }),
        ...(permissions ? { permissions } : {}),
      } as AcpBridgeConfig),
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  )

  return { clientConn, client, sideEffects }
}

async function runPrompt(harness: ReturnType<typeof buildHarness>) {
  await harness.clientConn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  const { sessionId } = await harness.clientConn.newSession({ cwd: '/project', mcpServers: [] })
  return harness.clientConn.prompt({ sessionId, prompt: [{ type: 'text', text: 'write a file' }] })
}

describe('real Strands Agent over a real ACP connection', () => {
  it('runs the tool and streams the answer when ungated', async () => {
    const harness = buildHarness([])
    const response = await runPrompt(harness)

    expect(harness.client.requests).toHaveLength(0)
    expect(harness.sideEffects).toEqual(['/tmp/a.txt'])
    expect(response.stopReason).toBe('end_turn')

    const text = harness.client.updates
      .filter((u) => (u.update as { sessionUpdate?: string }).sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.update as { content?: { text?: string } }).content?.text)
      .join('')
    expect(text).toContain('all done')
  })

  it('asks the client, then runs the real tool when allowed', async () => {
    const harness = buildHarness(['allow_once'], { default: 'ask' })
    await runPrompt(harness)

    expect(harness.client.requests).toHaveLength(1)
    expect(harness.client.requests[0].toolCall.title).toBe('write_file')
    expect(harness.client.requests[0].toolCall.kind).toBe('edit')
    expect(harness.client.requests[0].toolCall.locations).toEqual([{ path: '/tmp/a.txt' }])
    expect(harness.sideEffects).toEqual(['/tmp/a.txt'])
  })

  it('genuinely prevents the real tool from executing when rejected', async () => {
    const harness = buildHarness(['reject_once'], { default: 'ask' })
    await runPrompt(harness)

    expect(harness.client.requests).toHaveLength(1)
    // The whole point: the real agent loop honoured `event.cancel` and the tool
    // callback never ran, so the side effect never happened.
    expect(harness.sideEffects).toEqual([])
  })

  it('lets the model continue after a rejection instead of ending the turn', async () => {
    const harness = buildHarness(['reject_once'], { default: 'ask' })
    const response = await runPrompt(harness)

    // A rejection is a tool error the model can react to, not a dead turn: the
    // loop ran again and produced the follow-up text.
    expect(response.stopReason).toBe('end_turn')
    const text = harness.client.updates
      .filter((u) => (u.update as { sessionUpdate?: string }).sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.update as { content?: { text?: string } }).content?.text)
      .join('')
    expect(text).toContain('all done')
  })

  it('does not run a tool the policy denies outright', async () => {
    const harness = buildHarness([], { default: 'allow', tools: { write_file: 'deny' } })
    await runPrompt(harness)

    expect(harness.client.requests).toHaveLength(0)
    expect(harness.sideEffects).toEqual([])
  })
})
