import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import type { Agent } from '@strands-agents/sdk'
import { AcpAgent, type AcpBridgeConfig } from './acp-agent.js'

/**
 * Creates an ACP stdio server that bridges any Strands Agent to the
 * Agent Client Protocol over stdin/stdout (newline-delimited JSON-RPC).
 *
 * @param config - Either a simple factory function that returns a new Strands Agent
 *                 instance for each ACP session, or an AcpBridgeConfig object with
 *                 additional options like custom capabilities.
 *
 * @example
 * ```ts
 * import { createStdioServer } from 'strands-acp'
 * import { createAgent } from './my-agent.js'
 *
 * // Simple factory
 * createStdioServer(createAgent)
 *
 * // Config-based
 * createStdioServer({
 *   agentFactory: (sessionId, sessionParams) => createAgent(sessionId, sessionParams),
 *   capabilities: { promptCapabilities: { image: true } },
 * })
 * ```
 */
export function createStdioServer(
  config: ((sessionId: string) => Agent) | AcpBridgeConfig,
): acp.AgentSideConnection {
  const input = Writable.toWeb(process.stdout)
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  const stream = acp.ndJsonStream(input, output)
  return new acp.AgentSideConnection((conn) => new AcpAgent(conn, config), stream)
}
