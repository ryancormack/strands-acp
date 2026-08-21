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

### Session listing

`session/list` answers "which sessions can I resume?". The bridge only holds live
sessions in memory, so on its own it can answer that only for sessions the current
process created: after a restart the list is empty even though the sessions are
still on disk and still loadable.

Supply a `sessionStore` to close that. It carries the ACP-level record, which is
the part nothing else persists. A Strands `SessionManager` stores the
conversation, but `cwd` and `title` are ACP concepts the agent never sees, so they
cannot be recovered from a snapshot.

```ts
const config: AcpBridgeConfig = {
  agentFactory: (sessionId) => createAgent(sessionId),
  sessionStore: {
    async list({ cwd }) {
      const all = await readIndex()
      return cwd ? all.filter((s) => s.cwd === cwd) : all
    },
    async save(info) {
      await writeIndexEntry(info)
    },
  },
}
```

`list` receives `cwd` as a hint so a backend that can narrow the read does not
have to fetch everything. Ignoring it is safe: the bridge applies the same filter
to whatever comes back, so a store cannot leak sessions from another directory by
being lazy.

`save` is called when a session is created, loaded, resumed, and after each
completed turn. Write failures are reported on stderr and swallowed, because a
metadata write must never fail a user's turn. A `list` failure is not swallowed:
it propagates as an error, since returning only the live sessions would look to
the client like an authoritative "no other sessions exist".

Listing merges live and stored sessions, deduplicating by id with the live entry
winning, and sorts most-recently-updated first.

Titles come from the first prompt in a session that carries text, truncated at a
word boundary. Nothing else in the bridge knows anything human-readable about a
session, and a client's session picker needs something to show. A session whose
first turn was image-only stays untitled.

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

Remembered answers are held in memory for the lifetime of the live session and
are deliberately not persisted. Resuming a session with `session/load`, or
restarting the agent process, starts with an empty set and asks again. The
workspace may have changed in between, so a decision made against the old state
should not silently carry over. The `permissions` policy above is the durable
layer: it is configuration, so it survives restarts by definition, and
`allow_always` is a within-session convenience on top of it. A client is free to
persist its own answers and reply without prompting, which ACP permits but does
not require.

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
- **sessionStore** — durable store for ACP session metadata. Omitted means `session/list` reports only sessions this process created.

### `AcpAgent`

The core class that implements the `acp.Agent` interface, translating ACP requests into Strands agent interactions. It handles:

- Session lifecycle (create, list, resume, close)
- Prompt streaming with text, image, and tool call events
- Content block mapping (ACP to Strands types)
- Cancellation
- Stop reason mapping between Strands and ACP conventions

Some of these are narrower than the list suggests. See [Known gaps](#known-gaps).

You typically do not instantiate `AcpAgent` directly. Use `createStdioServer` for the standard transport, or create a custom transport by passing an `AcpAgent` to an `AgentSideConnection`.

## Known gaps

Things that are deliberately unfinished or narrower than they look. Each needs
closing before this becomes a first-party SDK feature.

**Session modes are accepted and ignored.** `setSessionMode` returns an empty
response without changing anything. No modes are advertised, so a conforming
client has nothing to switch to and will not call it, but if modes are ever
advertised the method will silently accept a mode change and do nothing. Modes
are ACP's standardised lever for persistent policy, so the natural
implementation is to map a mode onto a `PermissionPolicy` and swap the active
policy. Until then a client cannot express "plan mode denies every mutating
tool".

**`authenticate` always succeeds.** It returns an empty response without
checking anything. No `authMethods` are advertised, so a client should never
call it, but the default fails open rather than closed. An agent that needs
authentication must not rely on this method as written.

**`listSessions` needs a `sessionStore` to see past the current process.**
Without one it iterates the in-memory map only, so it returns an empty list after
a restart even when sessions are resumable from disk. See
[Session listing](#session-listing). Upstream this wants a real session
enumeration API on the SDK: the bridge cannot reach the storage its
`agentFactory` uses, and the on-disk key layout is an SDK internal it should not
be parsing.

**`loadSession` and `resumeSession` are not symmetric.** `loadSession` builds a
fresh session and replays history to the client. `resumeSession` requires the
session to already be in memory, rebuilds the agent from the factory, and does
not replay. The agent therefore holds history the client's transcript may not
show. This may be correct, since a client resuming an in-memory session
plausibly still has the transcript, but the difference is undocumented in ACP
and untested here.

**`loadSession` restamps timestamps.** `createdAt` and `lastUpdated` are set to
the load time, not the session's real times, so `listSessions` reports when a
session was last loaded rather than when it was last used.

**`mcpServers` is forwarded, not honoured.** The bridge passes the client's MCP
server list to the `agentFactory` and does nothing else with it. Connecting
those servers is the factory's job. A client that configures MCP servers and
expects the agent to reach them will see nothing happen unless the factory
implements it.

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
