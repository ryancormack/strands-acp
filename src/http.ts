import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Agent } from '@strands-agents/sdk'
import type { AgentApp } from '@agentclientprotocol/sdk'
import { AcpServer, type ConnectionLimits } from '@agentclientprotocol/sdk/experimental/server'
import {
  createNodeHttpHandler,
  type NodeHttpHandlerOptions,
} from '@agentclientprotocol/sdk/experimental/node'
import { createAgentApp, type AcpBridgeConfig, type Principal } from './acp-agent.js'
import { SessionRegistry } from './session-registry.js'

export type { Principal } from './acp-agent.js'

export interface HttpHandlerOptions extends ConnectionLimits, NodeHttpHandlerOptions {
  /**
   * Identifies the caller. Runs on every request, including the SSE `GET` and
   * the `DELETE` that ends a connection. Return `null` to answer 401.
   *
   * Callers only reach sessions and connections created under the same
   * `Principal.id`.
   */
  authenticate: (request: Request) => Principal | null | undefined | Promise<Principal | null | undefined>
}

export interface AcpHttpHandler {
  /** Fetch-style handler, for runtimes and frameworks built on `Request`/`Response`. */
  fetch(request: Request): Promise<Response>
  /** Handler for `node:http` / `node:http2` compat servers. */
  node(req: IncomingMessage, res: ServerResponse): void
  /** Closes every open ACP connection. Sessions stay in the registry. */
  close(): Promise<void>
}

/** Every request supplies its own agent, so the server-level default never runs. */
const NO_DEFAULT_AGENT = { createAgent: (): never => { throw new Error('strands-acp: no default agent') } }

/**
 * Routes each request to the `AcpServer` of the caller it authenticates as.
 * Connection ids live in each server's own registry, so one caller's id is
 * unknown (404) on another's.
 */
class PrincipalRouter extends AcpServer {
  private readonly servers = new Map<string, AcpServer>()

  constructor(
    private readonly authenticate: HttpHandlerOptions['authenticate'],
    private readonly limits: ConnectionLimits,
    private readonly appFor: (principal: Principal) => AgentApp,
  ) {
    // Never serves a request itself; it exists so the SDK's node adapter accepts it.
    super(NO_DEFAULT_AGENT)
  }

  override async handleRequest(request: Request): Promise<Response> {
    const principal = await this.authenticate(request)
    if (!principal) return new Response('Unauthorized', { status: 401 })
    if (typeof principal.id !== 'string' || principal.id === '') {
      throw new TypeError('authenticate must return a Principal with a non-empty string id')
    }

    let server = this.servers.get(principal.id)
    if (!server) {
      server = new AcpServer({ ...this.limits, ...NO_DEFAULT_AGENT })
      this.servers.set(principal.id, server)
    }
    // Only read when this request is an initialize, so each connection gets the claims it opened with.
    return server.handleRequest(request, { createAgent: () => this.appFor(principal) })
  }

  override async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => server.close()))
    this.servers.clear()
    await super.close()
  }
}

/**
 * Serves a Strands agent over ACP Streamable HTTP. Mount the returned handler
 * on your own server at the path clients connect to; TLS, binding and routing
 * stay with you.
 *
 * @example
 * ```ts
 * import { createServer } from 'node:http'
 * import { createHttpHandler } from '@ryancormack/strands-acp/http'
 *
 * const acp = createHttpHandler(createAgent, {
 *   authenticate: (req) => verifyBearer(req.headers.get('authorization')), // { id } or null
 * })
 * createServer((req, res) => (req.url === '/acp' ? acp.node(req, res) : res.writeHead(404).end()))
 *   .listen(8080, '127.0.0.1')
 * ```
 */
export function createHttpHandler(
  config: ((sessionId: string) => Agent) | AcpBridgeConfig,
  options: HttpHandlerOptions,
): AcpHttpHandler {
  if (typeof options?.authenticate !== 'function') {
    throw new TypeError('createHttpHandler requires an authenticate function')
  }
  const { authenticate, maxRequestBodyBytes, ...limits } = options

  const bridge: AcpBridgeConfig =
    typeof config === 'function'
      ? { agentFactory: (sessionId) => config(sessionId), sessions: new SessionRegistry() }
      : { ...config, sessions: config.sessions ?? new SessionRegistry() }

  const router = new PrincipalRouter(authenticate, limits, (principal) => createAgentApp(bridge, { principal }))
  const node = createNodeHttpHandler(router, { maxRequestBodyBytes })

  return {
    fetch: (request) => router.handleRequest(request),
    node,
    close: () => router.close(),
  }
}
