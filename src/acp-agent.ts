import * as acp from '@agentclientprotocol/sdk'

import { TextBlock, ImageBlock, type Agent } from '@strands-agents/sdk'
import type { ImageFormat } from '@strands-agents/sdk'
import {
  inferToolKind,
  extractLocations,
  mapStopReason,
  mapToolResultContent,
  SUPPORTED_IMAGE_FORMATS,
} from './mapping.js'
import {
  resolveDecision,
  interpretPermissionResponse,
  PERMISSION_OPTIONS,
  type PermissionPolicy,
  type PermissionDecision,
} from './permissions.js'
import { mergeSessionInfos, deriveTitle, type SessionStore } from './session-store.js'

/**
 * Configuration for the ACP bridge.
 */
export interface AcpBridgeConfig {
  /** Factory that creates a Strands Agent for each session. */
  agentFactory: (sessionId: string, sessionParams: acp.NewSessionRequest) => Agent
  /** Optional capabilities to advertise during initialization. Merged with defaults. */
  capabilities?: Partial<acp.AgentCapabilities>
  /**
   * Explicit tool-name to ACP tool-kind mapping. Any tool not listed here has
   * its kind inferred from its name. Kinds drive client icons and rendering.
   */
  toolKinds?: Record<string, acp.ToolKind>
  /**
   * Tool-call approval policy. When a tool resolves to `'ask'`, the client is
   * asked via `session/request_permission` before the tool runs and a rejection
   * is returned to the model as a tool error.
   *
   * Omitted means never ask, which preserves the previous behaviour.
   */
  permissions?: PermissionPolicy
  /**
   * Durable store for session metadata.
   *
   * Without one, `session/list` reports only sessions this process created, so
   * it returns an empty list after a restart even when sessions are resumable.
   * With one, stored sessions are merged into the listing and their titles
   * survive a reload.
   *
   * Supplying a store does not make the bridge persist conversation history:
   * that is the `agentFactory`'s job, normally via a Strands `SessionManager`.
   * This carries only the ACP-level record the protocol asks for.
   */
  sessionStore?: SessionStore
}

interface Session {
  agent: Agent
  /**
   * Decisions remembered from `allow_always` / `reject_always` answers.
   *
   * In-memory and intentionally not persisted: a resumed session starts empty
   * and asks again, because the workspace may have changed since the answer was
   * given. The configured {@link PermissionPolicy} is the durable layer.
   */
  permissionOverrides: Map<string, PermissionDecision>
  abortController: AbortController | null
  cwd: string
  createdAt: Date
  lastUpdated: Date
  title: string | null
  params: acp.NewSessionRequest
}

function generateSessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Extract ImageFormat from a MIME type string (e.g., 'image/png' -> 'png'). Throws for unsupported formats. */
function extractImageFormat(mimeType: string): ImageFormat {
  const format = mimeType.replace(/^image\//, '')
  if (!(SUPPORTED_IMAGE_FORMATS as readonly string[]).includes(format)) {
    throw new Error(
      `Unsupported image format: '${mimeType}'. Supported formats: ${SUPPORTED_IMAGE_FORMATS.join(', ')}`,
    )
  }
  return format as ImageFormat
}

export class AcpAgent implements acp.Agent {
  private connection: acp.AgentSideConnection
  private sessions = new Map<string, Session>()
  private agentFactory: (sessionId: string, sessionParams: acp.NewSessionRequest) => Agent
  private capabilitiesConfig: Partial<acp.AgentCapabilities> | undefined
  private toolKinds: Record<string, acp.ToolKind> | undefined
  private permissions: PermissionPolicy | undefined
  private sessionStore: SessionStore | undefined

  constructor(
    connection: acp.AgentSideConnection,
    config: ((sessionId: string) => Agent) | AcpBridgeConfig,
  ) {
    this.connection = connection
    if (typeof config === 'function') {
      // Backwards-compatible: simple factory function (ignores second param)
      this.agentFactory = (sessionId: string, _sessionParams: acp.NewSessionRequest) => config(sessionId)
      this.capabilitiesConfig = undefined
      this.toolKinds = undefined
      this.permissions = undefined
      this.sessionStore = undefined
    } else {
      this.agentFactory = config.agentFactory
      this.capabilitiesConfig = config.capabilities
      this.toolKinds = config.toolKinds
      this.permissions = config.permissions
      this.sessionStore = config.sessionStore
    }
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    const defaultCapabilities: acp.AgentCapabilities = {
      loadSession: true,
      sessionCapabilities: {
        close: {},
        list: {},
        resume: {},
      },
      promptCapabilities: {
        image: true,
      },
    }

    const mergedCapabilities: acp.AgentCapabilities = {
      ...defaultCapabilities,
      ...this.capabilitiesConfig,
      sessionCapabilities: {
        ...defaultCapabilities.sessionCapabilities,
        ...this.capabilitiesConfig?.sessionCapabilities,
      },
      promptCapabilities: {
        ...defaultCapabilities.promptCapabilities,
        ...this.capabilitiesConfig?.promptCapabilities,
      },
    }

    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: mergedCapabilities,
      agentInfo: {
        name: 'strands-acp-agent',
        version: '0.1.0',
      },
    }
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = generateSessionId()
    this.sessions.set(sessionId, {
      agent: this.agentFactory(sessionId, params),
      permissionOverrides: new Map(),
      abortController: null,
      cwd: params.cwd,
      createdAt: new Date(),
      lastUpdated: new Date(),
      title: null,
      params,
    })
    await this.persistSession(sessionId, this.sessions.get(sessionId)!)
    return { sessionId }
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const sessionParams = { cwd: params.cwd, mcpServers: params.mcpServers } as acp.NewSessionRequest
    const agent = this.agentFactory(params.sessionId, sessionParams)
    this.sessions.set(params.sessionId, {
      agent,
      permissionOverrides: new Map(),
      abortController: null,
      cwd: params.cwd,
      createdAt: new Date(),
      lastUpdated: new Date(),
      title: null,
      params: sessionParams,
    })

    // A stored title is the only human-readable label a reloaded session has.
    await this.adoptStoredTitle(params.sessionId)

    // Replay conversation history to the client via session updates.
    await this.replayHistory(params.sessionId, agent)

    await this.persistSession(params.sessionId, this.sessions.get(params.sessionId)!)
    return {}
  }

  /**
   * Replays a restored conversation to the client.
   *
   * Text, images, and tool calls are all forwarded. Replaying only text would
   * leave the client's transcript missing the images the user sent and every
   * tool the agent ran, which is the visible half of an agentic session.
   */
  private async replayHistory(sessionId: string, agent: Agent): Promise<void> {
    for (const message of agent.messages) {
      const updateType = message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk'

      for (const block of message.content) {
        if (block.type === 'textBlock') {
          await this.connection.sessionUpdate({
            sessionId,
            update: { sessionUpdate: updateType, content: { type: 'text', text: block.text } },
          })
        } else if (block.type === 'imageBlock') {
          const image = block as unknown as { format?: string; source?: { bytes?: Uint8Array } }
          const bytes = image.source?.bytes
          if (!bytes) continue
          await this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: updateType,
              content: {
                type: 'image',
                mimeType: `image/${image.format ?? 'png'}`,
                data: Buffer.from(bytes).toString('base64'),
              },
            },
          })
        } else if (block.type === 'toolUseBlock') {
          const toolUse = block as unknown as { toolUseId: string; name: string; input?: unknown }
          const kind = inferToolKind(toolUse.name, this.toolKinds)
          await this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: toolUse.toolUseId,
              title: toolUse.name,
              kind,
              status: 'completed',
              rawInput: (toolUse.input ?? {}) as Record<string, unknown>,
              locations: extractLocations(toolUse.input, kind),
            },
          })
        }
      }
    }
  }

  /**
   * Asks the client whether a tool call may proceed, when policy requires it.
   *
   * The agent is suspended at the `beforeToolCallEvent` yield for the duration,
   * so this can block on a human without any timeout of its own. On refusal the
   * event's `cancel` field is set, which the agent reads on resumption and turns
   * into an error tool result the model can react to.
   *
   * @returns `'allowed'`, `'denied'`, or `'cancelled'` when the client cancelled
   * the turn rather than answering.
   */
  /**
   * Builds a tool-call session update, as either a first announcement or an
   * update to one already sent.
   *
   * ACP expects exactly one `tool_call` per invocation followed by
   * `tool_call_update`s. The model stream announces a call as soon as it starts,
   * before the parsed input exists, so by the time the permission gate runs the
   * client may already know about this `toolCallId`. Sending a second `tool_call`
   * for it would have the client render the same invocation twice.
   */
  private toolCallNotification(
    event: { toolUse: { toolUseId: string; name: string; input: unknown } },
    kind: acp.ToolKind,
    locations: acp.ToolCallLocation[],
    status: acp.ToolCallStatus,
    alreadyAnnounced: boolean,
  ): acp.SessionUpdate {
    const locationField = locations.length > 0 ? { locations } : {}

    if (alreadyAnnounced) {
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.toolUse.toolUseId,
        status,
        rawInput: event.toolUse.input as Record<string, unknown>,
        ...locationField,
      }
    }

    return {
      sessionUpdate: 'tool_call',
      toolCallId: event.toolUse.toolUseId,
      title: event.toolUse.name,
      kind,
      status,
      rawInput: event.toolUse.input as Record<string, unknown>,
      ...locationField,
    }
  }

  private async gateToolCall(
    sessionId: string,
    session: Session,
    event: { toolUse: { toolUseId: string; name: string; input: unknown }; cancel?: boolean | string },
    kind: acp.ToolKind,
    locations: acp.ToolCallLocation[],
    alreadyAnnounced: boolean,
  ): Promise<{ outcome: 'allowed' | 'denied' | 'cancelled'; announced: boolean }> {
    const decision = resolveDecision(event.toolUse.name, this.permissions, session.permissionOverrides)

    // Ungated calls are announced by the caller, exactly as before.
    if (decision === 'allow') return { outcome: 'allowed', announced: alreadyAnnounced }

    if (decision === 'deny') {
      event.cancel = `Tool '${event.toolUse.name}' is not permitted by policy.`
      await this.connection.sessionUpdate({
        sessionId,
        update: this.toolCallNotification(event, kind, locations, 'failed', alreadyAnnounced),
      })
      return { outcome: 'denied', announced: true }
    }

    // 'ask' — announce the pending call so the client can show what it is
    // approving, then wait for the answer.
    await this.connection.sessionUpdate({
      sessionId,
      update: this.toolCallNotification(event, kind, locations, 'pending', alreadyAnnounced),
    })

    const response = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: event.toolUse.toolUseId,
        title: event.toolUse.name,
        kind,
        status: 'pending',
        rawInput: event.toolUse.input as Record<string, unknown>,
        ...(locations.length > 0 ? { locations } : {}),
      },
      options: [...PERMISSION_OPTIONS],
    })

    const outcome = interpretPermissionResponse(response)
    if (outcome.remember) session.permissionOverrides.set(event.toolUse.name, outcome.remember)

    if (outcome.allowed) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolUse.toolUseId,
          status: 'in_progress',
        },
      })
      return { outcome: 'allowed', announced: true }
    }

    event.cancel = outcome.cancelled
      ? 'The user cancelled this request.'
      : `The user rejected running '${event.toolUse.name}'.`

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.toolUse.toolUseId,
        status: 'failed',
      },
    })

    return { outcome: outcome.cancelled ? 'cancelled' : 'denied', announced: true }
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {}
  }

  async setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    return {}
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) throw acp.RequestError.resourceNotFound(params.sessionId)
    session.agent.cancel()
    session.abortController?.abort()
    this.sessions.delete(params.sessionId)
    return {}
  }

  /** Builds the ACP record for a session, which is exactly what a store holds. */
  private sessionInfo(sessionId: string, session: Session): acp.SessionInfo {
    return {
      sessionId,
      cwd: session.cwd,
      title: session.title,
      updatedAt: session.lastUpdated.toISOString(),
    }
  }

  /**
   * Writes a session's metadata to the store, if one is configured.
   *
   * Best-effort by design: a metadata write must never fail a user's turn, so a
   * failure is reported and swallowed. stdout carries the JSON-RPC stream, so
   * the diagnostic goes to stderr, which is where ACP clients look for agent
   * logs.
   */
  private async persistSession(sessionId: string, session: Session): Promise<void> {
    if (!this.sessionStore) return
    try {
      await this.sessionStore.save(this.sessionInfo(sessionId, session))
    } catch (err) {
      process.stderr.write(`strands-acp: could not persist session ${sessionId}: ${String(err)}\n`)
    }
  }

  /**
   * Restores a session's title from the store.
   *
   * `loadSession` builds a fresh in-memory session, which would otherwise reset
   * the title to null and leave a reloaded session unlabelled in the client's
   * picker. Looked up through `list` rather than a dedicated getter to keep the
   * store interface at three methods; the scan is over session metadata, not
   * conversation history.
   */
  private async adoptStoredTitle(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !this.sessionStore) return
    try {
      const stored = await this.sessionStore.list({})
      const match = stored.find((info) => info.sessionId === sessionId)
      if (match?.title) session.title = match.title
    } catch (err) {
      process.stderr.write(`strands-acp: could not read stored session ${sessionId}: ${String(err)}\n`)
    }
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const live = [...this.sessions].map(([sessionId, session]) => this.sessionInfo(sessionId, session))

    if (!this.sessionStore) {
      return { sessions: mergeSessionInfos(live, [], params.cwd) }
    }

    // A store failure propagates rather than degrading to the live-only list: an
    // empty result reads to the client as "no sessions exist", which would be a
    // wrong answer rather than a partial one.
    const stored = await this.sessionStore.list({ cwd: params.cwd })
    return { sessions: mergeSessionInfos(live, stored, params.cwd) }
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) throw acp.RequestError.resourceNotFound(params.sessionId)
    // Update cwd if the resume request provides one, preserving original params otherwise
    if (params.cwd) {
      session.cwd = params.cwd
      session.params = { ...session.params, cwd: params.cwd }
    }
    session.agent = this.agentFactory(params.sessionId, session.params)
    await this.persistSession(params.sessionId, session)
    return {}
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) throw acp.RequestError.resourceNotFound(params.sessionId)

    // The first prompt is the only human-readable thing the bridge ever learns
    // about a session, so it is what a client's session picker has to show.
    if (session.title === null) session.title = deriveTitle(params.prompt)

    session.abortController?.abort()
    session.abortController = new AbortController()
    const { signal } = session.abortController

    // Map ACP content blocks to Strands InvokeArgs
    const hasNonTextBlocks = params.prompt.some((c) => c.type !== 'text')
    let invokeArgs: string | InstanceType<typeof TextBlock | typeof ImageBlock>[]

    if (hasNonTextBlocks) {
      // Map to Strands ContentBlock array
      const contentBlocks: InstanceType<typeof TextBlock | typeof ImageBlock>[] = []
      for (const block of params.prompt) {
        if (block.type === 'text') {
          contentBlocks.push(new TextBlock((block as acp.TextContent & { type: 'text' }).text))
        } else if (block.type === 'image') {
          const imageContent = block as acp.ImageContent & { type: 'image' }
          const format = extractImageFormat(imageContent.mimeType)
          const bytes = Buffer.from(imageContent.data, 'base64')
          contentBlocks.push(new ImageBlock({ format, source: { bytes } }))
        }
        // Unknown block types are skipped
      }
      if (contentBlocks.length === 0) {
        throw new Error(
          `Prompt contained only unsupported content block types: ${params.prompt.map((b) => b.type).join(', ')}`,
        )
      }
      invokeArgs = contentBlocks
    } else {
      // Text-only: extract as plain string (existing behavior)
      invokeArgs = params.prompt
        .filter((c) => c.type === 'text')
        .map((c) => (c as acp.TextContent & { type: 'text' }).text)
        .join('\n')
    }

    let currentToolCallId: string | undefined
    let agentResult: { stopReason: string } | undefined
    let cancelledByPermission = false

    const gen = session.agent.stream(invokeArgs)

    try {
      let iterResult = await gen.next()
      while (!iterResult.done) {
        const event = iterResult.value
        if (signal.aborted) break

        switch (event.type) {
          case 'modelStreamUpdateEvent': {
            const inner = event.event
            if (inner.type === 'modelContentBlockDeltaEvent' && inner.delta.type === 'textDelta') {
              await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: inner.delta.text },
                },
              })
            } else if (
              inner.type === 'modelContentBlockDeltaEvent' &&
              inner.delta.type === 'reasoningContentDelta'
            ) {
              // Reasoning is a distinct update in ACP so clients can collapse it
              // separately from the answer.
              const reasoning = inner.delta as unknown as { text?: string }
              if (reasoning.text) {
                await this.connection.sessionUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: 'agent_thought_chunk',
                    content: { type: 'text', text: reasoning.text },
                  },
                })
              }
            } else if (inner.type === 'modelContentBlockStartEvent' && inner.start?.type === 'toolUseStart') {
              currentToolCallId = inner.start.toolUseId
              await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: inner.start.toolUseId,
                  title: inner.start.name,
                  kind: inferToolKind(inner.start.name, this.toolKinds),
                  status: 'in_progress',
                  rawInput: {},
                },
              })
            }
            break
          }
          case 'beforeToolCallEvent': {
            const kind = inferToolKind(event.toolUse.name, this.toolKinds)
            const locations = extractLocations(event.toolUse.input, kind)

            // The agent is suspended at this yield, so the permission round-trip
            // can take as long as the user needs. Setting `event.cancel` before
            // resuming the generator makes the agent skip the call and hand the
            // model an error result instead.
            const gateOutcome = await this.gateToolCall(
              params.sessionId,
              session,
              event,
              kind,
              locations,
              currentToolCallId === event.toolUse.toolUseId,
            )
            if (gateOutcome.outcome === 'cancelled') {
              cancelledByPermission = true
            }
            if (gateOutcome.outcome !== 'allowed') {
              currentToolCallId = undefined
              break
            }

            // The gate may have owned the first announcement. Either way the
            // client already knows this id, so send an update, not a second
            // tool_call.
            if (gateOutcome.announced) currentToolCallId = event.toolUse.toolUseId

            if (currentToolCallId === event.toolUse.toolUseId) {
              // The stream already announced this call with an empty input; fill
              // in the parsed arguments and the locations they resolve to.
              await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: event.toolUse.toolUseId,
                  rawInput: event.toolUse.input,
                  ...(locations.length > 0 ? { locations } : {}),
                },
              })
              break
            }
            currentToolCallId = event.toolUse.toolUseId
            await this.connection.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: event.toolUse.toolUseId,
                title: event.toolUse.name,
                kind,
                status: 'in_progress',
                rawInput: event.toolUse.input,
                ...(locations.length > 0 ? { locations } : {}),
              },
            })
            break
          }
          case 'afterToolCallEvent': {
            if (currentToolCallId) {
              // `error` is populated when the tool threw. Reporting every call as
              // completed hides real failures from the client.
              const failed = event.error !== undefined
              const content = mapToolResultContent(event.result)
              await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: currentToolCallId,
                  status: failed ? 'failed' : 'completed',
                  ...(content.length > 0 ? { content } : {}),
                },
              })
              currentToolCallId = undefined
            }
            break
          }
        }

        iterResult = await gen.next()
      }

      if (iterResult.done) {
        agentResult = iterResult.value as { stopReason: string }
      }
      // Releasing the generator runs its `finally` blocks. Breaking out of the
      // loop on cancellation without this leaves the agent's own cleanup pending.
      if (!iterResult.done) await gen.return(undefined as never)
    } catch (err) {
      await gen.return(undefined as never).catch(() => {})
      if (signal.aborted) return { stopReason: 'cancelled' }
      throw err
    }

    session.abortController = null
    session.lastUpdated = new Date()
    await this.persistSession(params.sessionId, session)
    if (cancelledByPermission) return { stopReason: 'cancelled' }
    return { stopReason: signal.aborted ? 'cancelled' : mapStopReason(agentResult?.stopReason ?? 'endTurn') }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    if (session) {
      session.agent.cancel()
      session.abortController?.abort()
    }
  }
}
