import * as acp from '@agentclientprotocol/sdk'

/**
 * Pure mapping helpers between Strands and ACP vocabularies.
 *
 * Kept separate from the connection handling in `acp-agent.ts` so each mapping
 * can be tested without standing up a JSON-RPC connection.
 */

/**
 * Heuristics mapping a tool name to an ACP {@link acp.ToolKind}.
 *
 * Clients use the kind to pick an icon and to decide how to render progress —
 * an `edit` renders a diff, a `read` renders a file link. Order matters: the
 * first matching pattern wins, so more specific patterns are listed first.
 */
const TOOL_KIND_PATTERNS: ReadonlyArray<readonly [RegExp, acp.ToolKind]> = [
  [/(^|_)(think|reason|plan|reflect)/i, 'think'],
  [/(^|_)(fetch|http|request|curl|browse|download|scrape|web_?search)/i, 'fetch'],
  [/(^|_)(search|grep|glob|find|list_?dir|ls|ripgrep)/i, 'search'],
  [/(^|_)(delete|remove|rm|unlink|rmdir)/i, 'delete'],
  [/(^|_)(move|rename|mv|copy|cp)/i, 'move'],
  [/(^|_)(edit|write|patch|apply|replace|insert|append|create_?file|mkdir|save)/i, 'edit'],
  [/(^|_)(read|cat|view|open|load|stat|head|tail)/i, 'read'],
  [/(^|_)(bash|sh|shell|exec|run|command|terminal|process|python|node)/i, 'execute'],
]

/**
 * Infers an ACP tool kind from a Strands tool name.
 *
 * Returns `'other'` when nothing matches, which is the kind the ACP schema
 * documents as the default. An explicit override always wins over inference.
 *
 * @param toolName - The Strands tool name, e.g. `file_read`.
 * @param overrides - Optional explicit name-to-kind map.
 */
export function inferToolKind(
  toolName: string,
  overrides?: Readonly<Record<string, acp.ToolKind>>,
): acp.ToolKind {
  const override = overrides?.[toolName]
  if (override) return override

  for (const [pattern, kind] of TOOL_KIND_PATTERNS) {
    if (pattern.test(toolName)) return kind
  }
  return 'other'
}

/** Input keys commonly used by file-touching tools, in order of preference. */
const PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filename',
  'fileName',
  'file',
  'target_path',
  'targetPath',
] as const

/**
 * Extracts file locations from a tool's input so the client can follow along
 * in the editor.
 *
 * Only emitted for tool kinds that actually refer to a file; a shell command
 * that happens to carry a `path` argument is not a file reference the editor
 * should jump to.
 *
 * @param input - The tool's parsed input.
 * @param kind - The tool kind, used to decide whether locations are meaningful.
 */
export function extractLocations(input: unknown, kind: acp.ToolKind): acp.ToolCallLocation[] {
  if (kind !== 'read' && kind !== 'edit' && kind !== 'delete' && kind !== 'move') return []
  if (input === null || typeof input !== 'object') return []

  const record = input as Record<string, unknown>
  const locations: acp.ToolCallLocation[] = []

  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) {
      const line = record.line ?? record.line_number ?? record.lineNumber
      locations.push({
        path: value,
        ...(typeof line === 'number' ? { line } : {}),
      })
      break
    }
  }

  return locations
}

/**
 * Maps a Strands stop reason to an ACP {@link acp.StopReason}.
 *
 * ACP has no stop reason meaning "waiting for a human", so `interrupt` has no
 * faithful mapping. Reporting it as `end_turn` would tell the client the agent
 * finished, so it is surfaced as `refusal` instead: the turn genuinely did not
 * complete, and the client should not present the result as a full answer.
 * Resolving this properly requires answering the permission request inside the
 * turn rather than ending it.
 *
 * @param strandsReason - The Strands `stopReason`.
 */
export function mapStopReason(strandsReason: string): acp.StopReason {
  switch (strandsReason) {
    case 'endTurn':
    // A `toolUse` stop means the loop yielded with a pending tool call. From the
    // client's perspective the turn is over either way.
    case 'toolUse':
    case 'stopSequence':
      return 'end_turn'
    case 'maxTokens':
    case 'modelContextWindowExceeded':
      return 'max_tokens'
    case 'cancelled':
      return 'cancelled'
    case 'contentFiltered':
    case 'guardrailIntervened':
    case 'interrupt':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

/** Image MIME subtypes the Strands `ImageBlock` accepts. */
export const SUPPORTED_IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const

/**
 * Converts a Strands tool result into ACP tool call content so the client has
 * something to render beyond a title.
 *
 * @param result - The Strands `ToolResultBlock`-shaped result.
 */
export function mapToolResultContent(result: unknown): acp.ToolCallContent[] {
  if (result === null || typeof result !== 'object') return []
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return []

  const mapped: acp.ToolCallContent[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { type?: string; text?: string }

    if (typed.type === 'textBlock' && typeof typed.text === 'string') {
      mapped.push({ type: 'content', content: { type: 'text', text: typed.text } })
    }
  }
  return mapped
}
