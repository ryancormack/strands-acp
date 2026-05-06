import * as acp from '@agentclientprotocol/sdk'

import type { Agent } from '@strands-agents/sdk'

interface Session {
  agent: Agent
  abortController: AbortController | null
  cwd: string
  createdAt: Date
  lastUpdated: Date
  title: string | null
}

function generateSessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Normalize a path by stripping trailing slashes (preserving bare '/'). */
const normalizePath = (p: string) => p.replace(/\/+$/, '') || '/'

function mapStopReason(strandsReason: string): acp.PromptResponse['stopReason'] {
  switch (strandsReason) {
    case 'endTurn':
      return 'end_turn'
    case 'maxTokens':
      return 'max_tokens'
    case 'cancelled':
      return 'cancelled'
    case 'contentFiltered':
    case 'guardrailIntervened':
      return 'refusal'
    case 'toolUse':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

export class AcpAgent implements acp.Agent {
  private connection: acp.AgentSideConnection
  private sessions = new Map<string, Session>()
  private agentFactory: (sessionId: string) => Agent

  constructor(connection: acp.AgentSideConnection, agentFactory: (sessionId: string) => Agent) {
    this.connection = connection
    this.agentFactory = agentFactory
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: {
          close: {},
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: 'strands-acp-agent',
        version: '0.1.0',
      },
    }
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = generateSessionId()
    this.sessions.set(sessionId, {
      agent: this.agentFactory(sessionId),
      abortController: null,
      cwd: params.cwd,
      createdAt: new Date(),
      lastUpdated: new Date(),
      title: null,
    })
    return { sessionId }
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

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const sessions: acp.SessionInfo[] = []
    for (const [sessionId, session] of this.sessions) {
      if (params.cwd && normalizePath(session.cwd) !== normalizePath(params.cwd)) continue
      sessions.push({
        sessionId,
        cwd: session.cwd,
        title: session.title,
        updatedAt: session.lastUpdated.toISOString(),
      })
    }
    return { sessions }
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) throw acp.RequestError.resourceNotFound(params.sessionId)
    session.agent = this.agentFactory(params.sessionId)
    return {}
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) throw acp.RequestError.resourceNotFound(params.sessionId)

    session.abortController?.abort()
    session.abortController = new AbortController()
    const { signal } = session.abortController

    const text = params.prompt
      .filter((c) => c.type === 'text')
      .map((c) => (c as acp.TextContent & { type: 'text' }).text)
      .join('\n')

    let currentToolCallId: string | undefined
    let agentResult: { stopReason: string } | undefined

    try {
      const gen = session.agent.stream(text)
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
            } else if (inner.type === 'modelContentBlockStartEvent' && inner.start?.type === 'toolUseStart') {
              currentToolCallId = inner.start.toolUseId
              await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: inner.start.toolUseId,
                  title: inner.start.name,
                  kind: 'execute',
                  status: 'in_progress',
                  rawInput: {},
                },
              })
            }
            break
          }
          case 'beforeToolCallEvent': {
            if (currentToolCallId === event.toolUse.toolUseId) break
            currentToolCallId = event.toolUse.toolUseId
            await this.connection.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: event.toolUse.toolUseId,
                title: event.toolUse.name,
                kind: 'execute',
                status: 'in_progress',
                rawInput: {},
              },
            })
            break
          }
          case 'afterToolCallEvent': {
            if (currentToolCallId) {
              await this.connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: currentToolCallId,
                  status: 'completed',
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
    } catch (err) {
      if (signal.aborted) return { stopReason: 'cancelled' }
      throw err
    }

    session.abortController = null
    session.lastUpdated = new Date()
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
