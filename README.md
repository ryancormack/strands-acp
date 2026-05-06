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

- Session lifecycle (create, list, resume, close)
- Prompt streaming with text and tool call events
- Cancellation
- Stop reason mapping between Strands and ACP conventions

You typically do not instantiate `AcpAgent` directly. Use `createStdioServer` for the standard transport, or create a custom transport by passing an `AcpAgent` to an `AgentSideConnection`.

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
