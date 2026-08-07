# @ryancormack/strands-acp

[![npm version](https://img.shields.io/npm/v/@ryancormack/strands-acp.svg)](https://www.npmjs.com/package/@ryancormack/strands-acp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Bridge any [Strands](https://github.com/strands-agents/sdk-typescript) agent to the [Agent Client Protocol (ACP)](https://agentclientprotocol.org/).

## Requirements

- Node.js >= 18
- `@strands-agents/sdk` is a peer dependency and must be installed in your project

## Installation

```bash
pnpm add @ryancormack/strands-acp @agentclientprotocol/sdk
```

Or using npm:

```bash
npm install @ryancormack/strands-acp @agentclientprotocol/sdk
```

Or using yarn:

```bash
yarn add @ryancormack/strands-acp @agentclientprotocol/sdk
```

> **Note:** `@strands-agents/sdk` is a peer dependency. Make sure it is installed in your project:
>
> ```bash
> pnpm add @strands-agents/sdk
> # or: npm install @strands-agents/sdk
> # or: yarn add @strands-agents/sdk
> ```

## Usage

### Simple factory

The simplest way to expose a Strands agent over ACP is with the stdio transport:

```ts
import { createStdioServer } from '@ryancormack/strands-acp'
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
import { createStdioServer, type AcpBridgeConfig } from '@ryancormack/strands-acp'
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
  loadSession: true,
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

### Session Management

When `loadSession: true` is advertised (the default), clients can call `loadSession` with a known `sessionId` to restore a previous session.

**How it works:**

1. The `agentFactory` is called with the given `sessionId`.
2. The resulting agent's `messages` array is streamed back to the client. Text, images, and tool calls are all replayed, so the restored transcript keeps the images the user sent and the tools the agent ran.

**Session persistence pattern:**

The agent factory is responsible for restoring conversation state when given a known `sessionId`. For example, you can use a `SessionManager` plugin that loads messages from a persistent store:

```ts
const config: AcpBridgeConfig = {
  agentFactory: (sessionId) => {
    // The agent restores its messages from a persistent store
    return agent({
      model: myModel,
      tools: myTools,
      sessionManager: new PersistentSessionManager(sessionId),
    })
  },
}
```

### Tool Call Handling

#### Tool kinds

ACP clients use a tool's `kind` to choose an icon and decide how to render
progress — an `edit` renders a diff, a `read` renders a file link. The kind is
inferred from the tool name, and falls back to `other` (the ACP default) rather
than mislabelling everything as `execute`:

| Tool name pattern | Kind |
| --- | --- |
| `file_read`, `cat`, `view` | `read` |
| `file_write`, `apply_patch`, `str_replace` | `edit` |
| `delete_file`, `rm` | `delete` |
| `move_file`, `rename` | `move` |
| `grep`, `glob`, `find` | `search` |
| `web_search`, `http_request` | `fetch` |
| `bash`, `run_command`, `python` | `execute` |
| `think`, `plan` | `think` |

Override the inference for any tool:

```ts
createStdioServer({
  agentFactory: createAgent,
  toolKinds: { calculate_tax: 'other', my_editor: 'edit' },
})
```

#### Locations

File-oriented tool calls (`read`, `edit`, `delete`, `move`) carry `locations`
extracted from the tool input, so the editor can follow along with the agent.
A `path` argument on a shell command is not reported as a file location.

#### rawInput forwarding

When a tool call begins via `beforeToolCallEvent`, the full structured input from
the agent is forwarded as `rawInput`, so clients can display tool parameters
immediately without waiting for the tool to complete.

#### Deduplication

When the agent's stream emits both a `modelContentBlockStartEvent` and a
`beforeToolCallEvent` for the same tool call id, only one `tool_call`
notification is sent: the initial one with empty `rawInput`, followed by a
`tool_call_update` carrying the complete input.

#### Results and failures

`afterToolCallEvent` carries an `error` when the tool threw. Failures are
reported as `status: 'failed'`, not `completed`, and the tool result is forwarded
as `content` so the client has something to render.

### Permissions

By default the bridge does not gate tool calls, which keeps existing setups
working unchanged. Supply a `permissions` policy to have the agent ask the client
before it acts:

```ts
createStdioServer({
  agentFactory: createAgent,
  permissions: {
    default: 'ask',
    tools: { file_read: 'allow', delete_file: 'deny' },
  },
})
```

Each decision is one of:

- `allow` — run without asking.
- `ask` — send `session/request_permission` and wait for the user.
- `deny` — refuse without asking the client.

The client is offered the four ACP option kinds (`allow_once`, `allow_always`,
`reject_once`, `reject_always`). An `allow_always` or `reject_always` answer is
remembered for the rest of the session, so the user is asked once per tool.

A rejection does not end the turn. The tool is skipped and the model receives an
error result for that call, so it can explain itself or try another approach. An
unrecognised option id fails closed.

This works because `agent.stream()` is an async generator: the agent is suspended
at the `beforeToolCallEvent` yield while the permission request is in flight, so
the round-trip can take as long as the user needs, and setting the event's
`cancel` field before resuming makes the agent skip the call. No timeout of the
bridge's own is imposed.

### Reasoning

Reasoning deltas are sent as `agent_thought_chunk` rather than mixed into the
assistant message, so clients can collapse them separately from the answer.

### Cancellation

`session/cancel` aborts the in-flight prompt and releases the agent's stream, so
the agent's own cleanup runs rather than being left pending.

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
  toolKinds?: Record<string, ToolKind>
  permissions?: PermissionPolicy
}

interface PermissionPolicy {
  default?: 'allow' | 'ask' | 'deny'
  tools?: Record<string, 'allow' | 'ask' | 'deny'>
}
```

- **agentFactory** — called for each new session and on resume. Receives the session id and the full `NewSessionRequest` params (cwd, mcpServers, etc.).
- **capabilities** — optional partial capabilities merged with defaults and advertised in the `initialize` response.
- **toolKinds** — explicit tool-name to ACP tool-kind mapping. Any tool not listed has its kind inferred from its name.
- **permissions** — tool-call approval policy. Omitted means never ask.

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
