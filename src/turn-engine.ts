import type { Agent } from '@strands-agents/sdk'
import type { StrandsInput } from './prompt-input.js'

export interface ToolUse {
  toolUseId: string
  name: string
  input: unknown
}

/** What a sink decides for a tool call the agent is about to run. */
export type ToolGateResult =
  | { allowed: true }
  | { allowed: false; reason?: string; cancelTurn?: boolean }

/**
 * Receives one Strands turn as protocol-neutral events. Each ACP version renders
 * these into its own wire shape; nothing here knows about ACP.
 */
export interface TurnSink {
  textDelta(text: string): Promise<void>
  thoughtDelta(text: string): Promise<void>
  /** The model started a tool call. Its input has not been parsed yet. */
  toolStarted(call: { toolUseId: string; name: string }): Promise<void>
  /**
   * The agent is suspended before running the call, so this may block on a
   * human. `priorCancel` is set when an intervention handler already refused it.
   */
  beforeToolCall(call: ToolUse, priorCancel: boolean | string | undefined): Promise<ToolGateResult>
  toolFinished(call: { toolUseId: string; failed: boolean; result: unknown }): Promise<void>
}

export type TurnResult =
  | { outcome: 'completed'; stopReason: string | undefined; cancelledByGate: boolean }
  /** The stream threw after the turn was aborted. */
  | { outcome: 'aborted' }

export async function runTurn(
  agent: Agent,
  input: StrandsInput,
  signal: AbortSignal,
  sink: TurnSink,
): Promise<TurnResult> {
  let cancelledByGate = false
  let stopReason: string | undefined
  const gen = agent.stream(input)

  try {
    let iterResult = await gen.next()
    while (!iterResult.done) {
      const event = iterResult.value
      if (signal.aborted) break

      switch (event.type) {
        case 'modelStreamUpdateEvent': {
          const inner = event.event
          if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta.type === 'textDelta') {
            await sink.textDelta(inner.delta.text)
          } else if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta.type === 'reasoningContentDelta') {
            const reasoning = inner.delta as unknown as { text?: string }
            if (reasoning.text) await sink.thoughtDelta(reasoning.text)
          } else if (inner.type === 'modelContentBlockStartEvent' && inner.start?.type === 'toolUseStart') {
            await sink.toolStarted({ toolUseId: inner.start.toolUseId, name: inner.start.name })
          }
          break
        }
        case 'beforeToolCallEvent': {
          // Setting `event.cancel` before resuming makes the agent skip the call
          // and hand the model an error result instead.
          const gate = await sink.beforeToolCall(event.toolUse, event.cancel)
          if (!gate.allowed) {
            if (gate.reason !== undefined) event.cancel = gate.reason
            if (gate.cancelTurn) cancelledByGate = true
          }
          break
        }
        case 'afterToolCallEvent': {
          await sink.toolFinished({
            toolUseId: event.toolUse.toolUseId,
            failed: event.error !== undefined,
            result: event.result,
          })
          break
        }
      }

      iterResult = await gen.next()
    }

    if (iterResult.done) stopReason = (iterResult.value as { stopReason: string }).stopReason
    // Releasing the generator runs its `finally` blocks, which a cancellation break skips.
    else await gen.return(undefined as never)
  } catch (err) {
    await gen.return(undefined as never).catch(() => {})
    if (signal.aborted) return { outcome: 'aborted' }
    throw err
  }

  return { outcome: 'completed', stopReason, cancelledByGate }
}
