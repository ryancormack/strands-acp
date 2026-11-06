import type * as acp from '@agentclientprotocol/sdk'
import type { Agent } from '@strands-agents/sdk'
import type { PermissionDecision } from './permissions.js'

export interface Session {
  agent: Agent
  /** `Principal.id` of the caller that created it; undefined on transports without identity. */
  owner: string | undefined
  /**
   * Decisions remembered from `allow_always` / `reject_always` answers.
   *
   * In-memory and intentionally not persisted: a resumed session starts empty
   * and asks again, because the workspace may have changed since the answer was
   * given. The configured `PermissionPolicy` is the durable layer.
   */
  permissionOverrides: Map<string, PermissionDecision>
  abortController: AbortController | null
  cwd: string
  createdAt: Date
  lastUpdated: Date
  title: string | null
  params: acp.NewSessionRequest
}

/**
 * Live sessions, held outside any single connection so a client that
 * reconnects finds its sessions still there.
 */
export class SessionRegistry {
  private sessions = new Map<string, Session>()

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  set(sessionId: string, session: Session): void {
    this.sessions.set(sessionId, session)
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  get size(): number {
    return this.sessions.size
  }

  entries(): IterableIterator<[string, Session]> {
    return this.sessions.entries()
  }
}
