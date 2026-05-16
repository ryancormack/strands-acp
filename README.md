# strands-acp

Bridge any [Strands](https://github.com/strands-agents/sdk-typescript) agent to the [Agent Client Protocol (ACP)](https://agentclientprotocol.org/).

## Installation

```bash
pnpm add strands-acp @agentclientprotocol/sdk
```

> **Note:** `@strands-agents/sdk` is a peer dependency. Make sure it is installed in your project:
>
> ```bash
> pnpm add @strands-agents/sdk
> ```

## Usage

The simplest way to expose a Strands agent over ACP is with the stdio transport:

```ts
import { createStdioServer } from 'strands-acp'
import { agent } from '@strands-agents/sdk'

function createAgent(_sessionId: string) {
  return agent({ model: myModel, tools: myTools })
}

createStdioServer(createAgent)
```

This starts a JSON-RPC server on stdin/stdout that any ACP-compatible client can connect to.

## API

### `createStdioServer(agentFactory)`

Creates an ACP stdio server bridging a Strands Agent to the Agent Client Protocol over stdin/stdout (newline-delimited JSON-RPC).

- **agentFactory** `(sessionId: string) => Agent` - A function that returns a new Strands Agent instance for each ACP session.
- **Returns** `AgentSideConnection`

### `AcpAgent`

The core class that implements the `acp.Agent` interface, translating ACP requests into Strands agent interactions. It handles:

- Session lifecycle (create, list, resume, close, loadSession)
- Prompt streaming with text and tool call events
- Cancellation
- Stop reason mapping between Strands and ACP conventions

You typically do not instantiate `AcpAgent` directly. Use `createStdioServer` for the standard transport, or create a custom transport by passing an `AcpAgent` to an `AgentSideConnection`.

## Session Management

### Loading Previous Sessions

The `loadSession` capability allows clients to restore a previously persisted session. When a client calls `loadSession` with a known `sessionId`, the agent factory is invoked with that ID, and the full conversation history stored in the agent's `messages` array is streamed back to the client as `user_message_chunk` and `agent_message_chunk` session updates.

This enables clients to display the prior conversation context without re-prompting the agent.

### Session Persistence

The `agentFactory` function receives a `sessionId` that can be used to restore conversation state. If your agent implementation uses a persistence layer (e.g., a SessionManager plugin), it can reload the agent's `messages` array from storage when constructed with an existing session ID. The `loadSession` method then iterates those messages and replays the history back to the client.

On `resumeSession`, a fresh agent is created for the same session ID. The SessionManager plugin will auto-restore conversation state on the first `stream` or `invoke` call.

## Tool Call Handling

### Structured Input Forwarding

Tool calls forward the structured input from the model via the `rawInput` field. When a `beforeToolCallEvent` fires, the `tool_call` notification includes `rawInput` set to `event.toolUse.input`, giving clients full visibility into the parameters passed to the tool.

### Deduplication

When both `modelContentBlockStartEvent` and `beforeToolCallEvent` fire for the same tool use ID, only one `tool_call` notification is emitted (from the stream event). The subsequent `beforeToolCallEvent` sends a `tool_call_update` carrying the `rawInput` instead of emitting a duplicate `tool_call`.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Run tests
pnpm test
```

## License

MIT
