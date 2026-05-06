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

### Simple factory

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

### Config-based setup

For more control, pass an `AcpBridgeConfig` object. This lets you configure capabilities and receive session parameters in the factory:

```ts
import { createStdioServer, type AcpBridgeConfig } from 'strands-acp'
import { agent } from '@strands-agents/sdk'

const config: AcpBridgeConfig = {
  agentFactory: (sessionId, sessionParams) => {
    // sessionParams includes cwd, mcpServers, additionalDirectories, etc.
    console.log(`Creating agent for session ${sessionId} in ${sessionParams.cwd}`)
    return agent({ model: myModel, tools: myTools })
  },
  capabilities: {
    promptCapabilities: { image: true },
  },
}

createStdioServer(config)
```

The `capabilities` field lets you override the defaults advertised during initialization. Defaults are:

```ts
{
  loadSession: false,
  sessionCapabilities: { close: {}, list: {}, resume: {} },
  promptCapabilities: { image: true },
}
```

### Content block mapping

The bridge automatically maps ACP content blocks to Strands types:

- **Text-only prompts** are passed as a plain string to `agent.stream(text)`.
- **Prompts with images** (or mixed content) are mapped to a Strands `ContentBlock[]` array:
  - ACP `text` blocks become `TextBlock` instances
  - ACP `image` blocks (base64 data + mimeType) become `ImageBlock` instances

This means your agent can receive multimodal input when the client sends image content.

## API

### `createStdioServer(config)`

Creates an ACP stdio server bridging a Strands Agent to the Agent Client Protocol over stdin/stdout (newline-delimited JSON-RPC).

- **config** `((sessionId: string) => Agent) | AcpBridgeConfig` - Either a simple factory function or a full configuration object.
- **Returns** `AgentSideConnection`

### `AcpBridgeConfig`

```ts
interface AcpBridgeConfig {
  agentFactory: (sessionId: string, sessionParams: NewSessionRequest) => Agent
  capabilities?: Partial<AgentCapabilities>
}
```

- **agentFactory** - Called for each new session and on resume. Receives the session ID and the full `NewSessionRequest` params (cwd, mcpServers, etc.).
- **capabilities** - Optional partial capabilities merged with defaults and advertised in the `initialize` response.

### `AcpAgent`

The core class that implements the `acp.Agent` interface, translating ACP requests into Strands agent interactions. It handles:

- Session lifecycle (create, list, resume, close)
- Prompt streaming with text, image, and tool call events
- Content block mapping (ACP to Strands types)
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
