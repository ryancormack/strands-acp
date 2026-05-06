import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import type { Agent } from '@strands-agents/sdk'
import { AcpAgent } from './acp-agent.js'

/**
 * Creates an ACP stdio server that bridges any Strands Agent to the
 * Agent Client Protocol over stdin/stdout (newline-delimited JSON-RPC).
 *
 * @param agentFactory - A function that returns a new Strands Agent instance
 *                       for each ACP session.
 *
 * @example
 * ```ts
 * import { createStdioServer } from 'strands-acp'
 * import { createAgent } from './my-agent.js'
 *
 * createStdioServer(createAgent)
 * ```
 */
export function createStdioServer(agentFactory: (sessionId: string) => Agent): acp.AgentSideConnection {
  const input = Writable.toWeb(process.stdout)
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  const stream = acp.ndJsonStream(input, output)
  return new acp.AgentSideConnection((conn) => new AcpAgent(conn, agentFactory), stream)
}
