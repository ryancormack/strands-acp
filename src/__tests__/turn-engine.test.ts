import { describe, it, expect } from 'vitest'
import type { Agent } from '@strands-agents/sdk'
import { runTurn, type TurnSink, type ToolGateResult } from '../turn-engine.js'

function agentFrom(events: Array<Record<string, unknown>>, result = { stopReason: 'endTurn' }): Agent {
  return {
    stream: async function* () {
      for (const event of events) yield event as never
      return result as never
    },
  } as unknown as Agent
}

function recordingSink(gate: ToolGateResult = { allowed: true }) {
  const calls: unknown[][] = []
  const sink: TurnSink = {
    textDelta: async (text) => void calls.push(['text', text]),
    thoughtDelta: async (text) => void calls.push(['thought', text]),
    toolStarted: async (call) => void calls.push(['started', call.toolUseId]),
    beforeToolCall: async (call, prior) => {
      calls.push(['before', call.toolUseId, prior])
      return gate
    },
    toolFinished: async (call) => void calls.push(['finished', call.toolUseId, call.failed]),
  }
  return { sink, calls }
}

const toolUse = { toolUseId: 't1', name: 'read', input: { path: 'a' } }
const toolEvents = [
  {
    type: 'modelStreamUpdateEvent',
    event: { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', toolUseId: 't1', name: 'read' } },
  },
  { type: 'beforeToolCallEvent', toolUse },
  { type: 'afterToolCallEvent', toolUse, result: { content: [] } },
]

describe('runTurn', () => {
  it('emits neutral events in stream order and returns the stop reason', async () => {
    const agent = agentFrom(
      [
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'hm' } } },
        { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'hi' } } },
        ...toolEvents,
      ],
      { stopReason: 'maxTokens' },
    )
    const { sink, calls } = recordingSink()

    const result = await runTurn(agent, 'go', new AbortController().signal, sink)

    expect(calls).toEqual([
      ['thought', 'hm'],
      ['text', 'hi'],
      ['started', 't1'],
      ['before', 't1', undefined],
      ['finished', 't1', false],
    ])
    expect(result).toEqual({ outcome: 'completed', stopReason: 'maxTokens', cancelledByGate: false })
  })

  it('writes a refusal reason onto the Strands event and flags a cancelled turn', async () => {
    const before = { type: 'beforeToolCallEvent', toolUse } as { cancel?: unknown }
    const agent = agentFrom([before as Record<string, unknown>])
    const { sink } = recordingSink({ allowed: false, reason: 'no', cancelTurn: true })

    const result = await runTurn(agent, 'go', new AbortController().signal, sink)

    expect(before.cancel).toBe('no')
    expect(result).toMatchObject({ outcome: 'completed', cancelledByGate: true })
  })

  it('reports aborted when the stream throws after cancellation', async () => {
    const controller = new AbortController()
    const agent = {
      stream: async function* () {
        controller.abort()
        throw new Error('interrupted')
      },
    } as unknown as Agent

    const result = await runTurn(agent, 'go', controller.signal, recordingSink().sink)

    expect(result).toEqual({ outcome: 'aborted' })
  })
})
