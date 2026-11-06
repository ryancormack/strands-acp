import * as acp from '@agentclientprotocol/sdk'

import type { Agent } from '@strands-agents/sdk'
import {
  inferToolKind,
  extractLocations,
  mapStopReason,
  mapToolResultContent,
} from './mapping.js'
import { toStrandsInput } from './prompt-input.js'
import { runTurn, type TurnSink } from './turn-engine.js'
import {
  resolveDecision,
  interpretPermissionResponse,
  PERMISSION_OPTIONS,
  type PermissionPolicy,
} from './permissions.js'
import { SessionRegistry, type Session } from './session-registry.js'
import {
  mergeSessionInfos,
  deriveTitle,
  STRANDS_SESSION_ID_PATTERN,
  type SessionStore,
} from './session-store.js'

/** An authenticated caller. `id` is what sessions are owned by; other fields are claims. */
export interface Principal {
  id: string
  [claim: string]: unknown
}

/** Per-session context handed to `agentFactory`. */
export interface SessionContext {
  /** The caller, on transports that authenticate one. Use it to scope session storage per tenant. */
  principal?: Principal
}

/**
 * Configuration for the ACP bridge.
 */
export interface AcpBridgeConfig {
  /**
   * Factory that creates a Strands Agent for each session.
   *
   * `sessionId` is not an opaque handle to pass over: it is the Strands session
   * id. Forward it to a `SessionManager` (`new SessionManager({ sessionId })`)
   * and history persists and replays on `session/load`. Drop it and each
   * session starts empty, because nothing else tells Strands which snapshot
   * belongs to this conversation.
   *
   * The id always matches {@link STRANDS_SESSION_ID_PATTERN}, so it can be used
   * as a storage key without sanitising.
   */
  agentFactory: (sessionId: string, sessionParams: acp.NewSessionRequest, context: SessionContext) => Agent
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
  /**
   * Where live sessions are held. Every connection served by the same app
   * already shares one; pass your own to share sessions across several apps.
   */
  sessions?: SessionRegistry
}

/**
 * Generates a session id that is also usable as a Strands session id.
 *
 * Lowercase hex satisfies {@link STRANDS_SESSION_ID_PATTERN}. The check keeps
 * the encoding and that requirement tied together, so changing the encoding to
 * something Strands rejects (an uppercase UUID, a prefix with a colon) fails
 * here instead of deep inside a caller's `SessionManager`.
 */
function generateSessionId(): string {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  if (!STRANDS_SESSION_ID_PATTERN.test(id)) {
    throw new Error(
      `generated session id '${id}' is not usable as a Strands session id (must match ${STRANDS_SESSION_ID_PATTERN})`,
    )
  }

  return id
}

type Client = acp.AgentContext

/** Where a session's owner is kept on the record a `SessionStore` saves. */
export const OWNER_META_KEY = 'strands-acp/owner'

function storedOwner(info: acp.SessionInfo | undefined): string | undefined {
  const owner = info?._meta?.[OWNER_META_KEY]
  return typeof owner === 'string' ? owner : undefined
}

/** The owner id stays server-side; it is not the client's to see. */
function withoutOwner(info: acp.SessionInfo): acp.SessionInfo {
  if (!info._meta || !(OWNER_META_KEY in info._meta)) return info
  const { [OWNER_META_KEY]: _owner, ...meta } = info._meta
  const { _meta: _ignored, ...rest } = info
  return Object.keys(meta).length > 0 ? { ...rest, _meta: meta } : rest
}

/**
 * Translates ACP v1 requests into Strands agent calls. Holds no connection:
 * each handler is given the client of the connection the request arrived on.
 */
export class AcpAgent {
  private sessions: SessionRegistry
  private agentFactory: AcpBridgeConfig['agentFactory']
  private capabilitiesConfig: Partial<acp.AgentCapabilities> | undefined
  private toolKinds: Record<string, acp.ToolKind> | undefined
  private permissions: PermissionPolicy | undefined
  private sessionStore: SessionStore | undefined
  private principal: Principal | undefined
  private context: SessionContext

  constructor(config: ((sessionId: string) => Agent) | AcpBridgeConfig, principal?: Principal) {
    this.principal = principal
    this.context = principal ? { principal } : {}
    if (typeof config === 'function') {
      // Backwards-compatible: simple factory function (ignores second param)
      this.agentFactory = (sessionId: string) => config(sessionId)
      this.capabilitiesConfig = undefined
      this.toolKinds = undefined
      this.permissions = undefined
      this.sessionStore = undefined
      this.sessions = new SessionRegistry()
    } else {
      this.agentFactory = config.agentFactory
      this.capabilitiesConfig = config.capabilities
      this.toolKinds = config.toolKinds
      this.permissions = config.permissions
      this.sessionStore = config.sessionStore
      this.sessions = config.sessions ?? new SessionRegistry()
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
      agent: this.agentFactory(sessionId, params, this.context),
      owner: this.principal?.id,
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

  /** Another caller's session reads as not found, so its existence is not disclosed. */
  private ownedSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId)
    return session && session.owner === this.principal?.id ? session : undefined
  }

  async loadSession(params: acp.LoadSessionRequest, client: Client): Promise<acp.LoadSessionResponse> {
    const owner = this.principal?.id
    const live = this.sessions.get(params.sessionId)
    if (live && live.owner !== owner) throw acp.RequestError.resourceNotFound(params.sessionId)

    let stored: acp.SessionInfo | undefined
    if (this.sessionStore) {
      try {
        stored = (await this.sessionStore.list({})).find((info) => info.sessionId === params.sessionId)
      } catch (err) {
        // Without the record, ownership cannot be checked.
        if (owner !== undefined) throw err
        process.stderr.write(`strands-acp: could not read stored session ${params.sessionId}: ${String(err)}\n`)
      }
      if (owner !== undefined && storedOwner(stored) !== owner) {
        throw acp.RequestError.resourceNotFound(params.sessionId)
      }
    }

    const sessionParams = { cwd: params.cwd, mcpServers: params.mcpServers } as acp.NewSessionRequest
    const agent = this.agentFactory(params.sessionId, sessionParams, this.context)
    this.sessions.set(params.sessionId, {
      agent,
      owner,
      permissionOverrides: new Map(),
      abortController: null,
      cwd: params.cwd,
      createdAt: new Date(),
      lastUpdated: new Date(),
      // A stored title is the only human-readable label a reloaded session has.
      title: stored?.title ?? null,
      params: sessionParams,
    })

    // Replay conversation history to the client via session updates.
    await this.replayHistory(params.sessionId, agent, client)

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
  private async replayHistory(sessionId: string, agent: Agent, client: Client): Promise<void> {
    const send = (update: acp.SessionUpdate) => client.notify('session/update', { sessionId, update })

    for (const message of agent.messages) {
      const updateType = message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk'

      for (const block of message.content) {
        if (block.type === 'textBlock') {
          await send({ sessionUpdate: updateType, content: { type: 'text', text: block.text } })
        } else if (block.type === 'imageBlock') {
          const image = block as unknown as { format?: string; source?: { bytes?: Uint8Array } }
          const bytes = image.source?.bytes
          if (!bytes) continue
          await send({
            sessionUpdate: updateType,
            content: {
              type: 'image',
              mimeType: `image/${image.format ?? 'png'}`,
              data: Buffer.from(bytes).toString('base64'),
            },
          })
        } else if (block.type === 'toolUseBlock') {
          const toolUse = block as unknown as { toolUseId: string; name: string; input?: unknown }
          const kind = inferToolKind(toolUse.name, this.toolKinds)
          await send({
            sessionUpdate: 'tool_call',
            toolCallId: toolUse.toolUseId,
            title: toolUse.name,
            kind,
            status: 'completed',
            rawInput: (toolUse.input ?? {}) as Record<string, unknown>,
            locations: extractLocations(toolUse.input, kind),
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
    client: Client,
    sessionId: string,
    session: Session,
    event: { toolUse: { toolUseId: string; name: string; input: unknown }; cancel?: boolean | string },
    kind: acp.ToolKind,
    locations: acp.ToolCallLocation[],
    alreadyAnnounced: boolean,
  ): Promise<{ outcome: 'allowed' | 'denied' | 'cancelled'; announced: boolean }> {
    const send = (update: acp.SessionUpdate) => client.notify('session/update', { sessionId, update })

    // Hooks are awaited before the event reaches this consumer, so anything the
    // agent's own intervention handlers decided is already on the event. A call
    // they cancelled cannot run whatever the user answers, and asking anyway
    // interrupts them for nothing and then discards the answer, which reads as
    // the editor ignoring them. Their reason is left in place: it is the one the
    // model receives, and it is more specific than anything this bridge knows.
    if (event.cancel) {
      await send(this.toolCallNotification(event, kind, locations, 'failed', alreadyAnnounced))
      return { outcome: 'denied', announced: true }
    }

    const decision = resolveDecision(event.toolUse.name, this.permissions, session.permissionOverrides)

    // Ungated calls are announced by the caller, exactly as before.
    if (decision === 'allow') return { outcome: 'allowed', announced: alreadyAnnounced }

    if (decision === 'deny') {
      event.cancel = `Tool '${event.toolUse.name}' is not permitted by policy.`
      await send(this.toolCallNotification(event, kind, locations, 'failed', alreadyAnnounced))
      return { outcome: 'denied', announced: true }
    }

    // 'ask' — announce the pending call so the client can show what it is
    // approving, then wait for the answer.
    await send(this.toolCallNotification(event, kind, locations, 'pending', alreadyAnnounced))

    const response = await client.request('session/request_permission', {
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
      await send({ sessionUpdate: 'tool_call_update', toolCallId: event.toolUse.toolUseId, status: 'in_progress' })
      return { outcome: 'allowed', announced: true }
    }

    event.cancel = outcome.cancelled
      ? 'The user cancelled this request.'
      : `The user rejected running '${event.toolUse.name}'.`

    await send({ sessionUpdate: 'tool_call_update', toolCallId: event.toolUse.toolUseId, status: 'failed' })

    return { outcome: outcome.cancelled ? 'cancelled' : 'denied', announced: true }
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {}
  }

  async setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    return {}
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    const session = this.ownedSession(params.sessionId)
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
      ...(session.owner !== undefined ? { _meta: { [OWNER_META_KEY]: session.owner } } : {}),
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

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const owner = this.principal?.id
    const live = [...this.sessions.entries()]
      .filter(([, session]) => session.owner === owner)
      .map(([sessionId, session]) => this.sessionInfo(sessionId, session))

    if (!this.sessionStore) {
      return { sessions: mergeSessionInfos(live, [], params.cwd).map(withoutOwner) }
    }

    // A store failure propagates rather than degrading to the live-only list: an
    // empty result reads to the client as "no sessions exist", which would be a
    // wrong answer rather than a partial one.
    const stored = (await this.sessionStore.list({ cwd: params.cwd })).filter(
      (info) => owner === undefined || storedOwner(info) === owner,
    )
    return { sessions: mergeSessionInfos(live, stored, params.cwd).map(withoutOwner) }
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    const session = this.ownedSession(params.sessionId)
    if (!session) throw acp.RequestError.resourceNotFound(params.sessionId)
    // Update cwd if the resume request provides one, preserving original params otherwise
    if (params.cwd) {
      session.cwd = params.cwd
      session.params = { ...session.params, cwd: params.cwd }
    }
    session.agent = this.agentFactory(params.sessionId, session.params, this.context)
    await this.persistSession(params.sessionId, session)
    return {}
  }

  async prompt(params: acp.PromptRequest, client: Client): Promise<acp.PromptResponse> {
    const session = this.ownedSession(params.sessionId)
    if (!session) throw acp.RequestError.resourceNotFound(params.sessionId)

    // The first prompt is the only human-readable thing the bridge ever learns
    // about a session, so it is what a client's session picker has to show.
    if (session.title === null) session.title = deriveTitle(params.prompt)

    session.abortController?.abort()
    session.abortController = new AbortController()
    const { signal } = session.abortController

    const input = toStrandsInput(params.prompt)
    const invocationState = { acp: { sessionId: params.sessionId, ...this.context } }
    const result = await runTurn(
      session.agent,
      input,
      signal,
      this.v1TurnSink(params.sessionId, session, client),
      invocationState,
    )
    if (result.outcome === 'aborted') return { stopReason: 'cancelled' }

    session.abortController = null
    session.lastUpdated = new Date()
    await this.persistSession(params.sessionId, session)
    if (result.cancelledByGate) return { stopReason: 'cancelled' }
    return { stopReason: signal.aborted ? 'cancelled' : mapStopReason(result.stopReason ?? 'endTurn') }
  }

  /**
   * Renders a turn as v1 session updates. v1 wants exactly one `tool_call` per
   * invocation followed by `tool_call_update`s, so this tracks which call the
   * client already knows about.
   */
  private v1TurnSink(sessionId: string, session: Session, client: Client): TurnSink {
    let currentToolCallId: string | undefined
    const send = (update: acp.SessionUpdate) => client.notify('session/update', { sessionId, update })

    return {
      textDelta: (text) => send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }),
      thoughtDelta: (text) => send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }),
      toolStarted: async ({ toolUseId, name }) => {
        currentToolCallId = toolUseId
        await send({
          sessionUpdate: 'tool_call',
          toolCallId: toolUseId,
          title: name,
          kind: inferToolKind(name, this.toolKinds),
          status: 'in_progress',
          rawInput: {},
        })
      },
      beforeToolCall: async (toolUse, priorCancel) => {
        const kind = inferToolKind(toolUse.name, this.toolKinds)
        const locations = extractLocations(toolUse.input, kind)
        const event = { toolUse, cancel: priorCancel }
        const gate = await this.gateToolCall(
          client,
          sessionId,
          session,
          event,
          kind,
          locations,
          currentToolCallId === toolUse.toolUseId,
        )
        if (gate.outcome !== 'allowed') {
          currentToolCallId = undefined
          return {
            allowed: false,
            ...(event.cancel !== priorCancel ? { reason: event.cancel as string } : {}),
            cancelTurn: gate.outcome === 'cancelled',
          }
        }

        if (gate.announced) currentToolCallId = toolUse.toolUseId
        const locationField = locations.length > 0 ? { locations } : {}

        if (currentToolCallId === toolUse.toolUseId) {
          await send({
            sessionUpdate: 'tool_call_update',
            toolCallId: toolUse.toolUseId,
            rawInput: toolUse.input as Record<string, unknown>,
            ...locationField,
          })
        } else {
          currentToolCallId = toolUse.toolUseId
          await send({
            sessionUpdate: 'tool_call',
            toolCallId: toolUse.toolUseId,
            title: toolUse.name,
            kind,
            status: 'in_progress',
            rawInput: toolUse.input as Record<string, unknown>,
            ...locationField,
          })
        }
        return { allowed: true }
      },
      toolFinished: async ({ failed, result }) => {
        if (!currentToolCallId) return
        const content = mapToolResultContent(result as Parameters<typeof mapToolResultContent>[0])
        await send({
          sessionUpdate: 'tool_call_update',
          toolCallId: currentToolCallId,
          status: failed ? 'failed' : 'completed',
          ...(content.length > 0 ? { content } : {}),
        })
        currentToolCallId = undefined
      },
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.ownedSession(params.sessionId)
    if (session) {
      session.agent.cancel()
      session.abortController?.abort()
    }
  }
}

/**
 * Builds an ACP v1 agent app for a Strands agent. Serve it with
 * `app.connect(stream)`, or hand it to the SDK's `AcpServer` or protocol
 * router; every connection it serves shares one set of sessions.
 *
 * With `options.principal`, the app serves that caller only: it sees and
 * touches only sessions it created. Give one app per caller the same
 * `config.sessions` registry.
 */
export function createAgentApp(
  config: ((sessionId: string) => Agent) | AcpBridgeConfig,
  options: { principal?: Principal } = {},
): acp.AgentApp {
  const bridge = new AcpAgent(config, options.principal)

  return acp
    .agent({ name: 'strands-acp' })
    .onRequest('initialize', ({ params }) => bridge.initialize(params))
    .onRequest('authenticate', ({ params }) => bridge.authenticate(params))
    .onRequest('session/new', ({ params }) => bridge.newSession(params))
    .onRequest('session/load', ({ params, client }) => bridge.loadSession(params, client))
    .onRequest('session/list', ({ params }) => bridge.listSessions(params))
    .onRequest('session/resume', ({ params }) => bridge.resumeSession(params))
    .onRequest('session/close', ({ params }) => bridge.closeSession(params))
    .onRequest('session/set_mode', ({ params }) => bridge.setSessionMode(params))
    .onRequest('session/prompt', ({ params, client }) => bridge.prompt(params, client))
    .onNotification('session/cancel', ({ params }) => bridge.cancel(params))
}
