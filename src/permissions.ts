import * as acp from '@agentclientprotocol/sdk'

/**
 * Tool-call approval policy.
 *
 * ACP lets the client own approval: the agent asks before acting and the user
 * answers in their editor. This module decides when to ask.
 */

/** What to do with a tool call before it runs. */
export type PermissionDecision = 'allow' | 'ask' | 'deny'

export interface PermissionPolicy {
  /** Decision for any tool not named in `tools`. Defaults to `'allow'`. */
  default?: PermissionDecision
  /** Per-tool decisions, keyed by Strands tool name. */
  tools?: Record<string, PermissionDecision>
}

/** The option ids offered to the client, mapped to ACP option kinds. */
export const PERMISSION_OPTIONS: readonly acp.PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow this tool', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Always reject this tool', kind: 'reject_always' },
]

/**
 * Resolves the policy for a tool, honouring decisions the user has already made
 * for the rest of the session.
 *
 * @param toolName - The Strands tool name.
 * @param policy - The configured policy, if any.
 * @param sessionOverrides - Decisions accumulated from `*_always` answers.
 */
export function resolveDecision(
  toolName: string,
  policy: PermissionPolicy | undefined,
  sessionOverrides: ReadonlyMap<string, PermissionDecision>,
): PermissionDecision {
  const remembered = sessionOverrides.get(toolName)
  if (remembered) return remembered

  const configured = policy?.tools?.[toolName]
  if (configured) return configured

  // Absent any policy the bridge does not gate, which keeps existing callers
  // working unchanged when they never configure permissions.
  return policy?.default ?? 'allow'
}

/** The result of asking the client about a tool call. */
export interface PermissionOutcome {
  /** Whether the tool may run. */
  allowed: boolean
  /** A decision to remember for the rest of the session, if the user said "always". */
  remember?: PermissionDecision
  /** True when the client cancelled the turn instead of answering. */
  cancelled: boolean
}

/**
 * Interprets an ACP permission response.
 *
 * An unrecognised option id is treated as a rejection: failing closed is the
 * safe reading when the answer cannot be understood.
 *
 * @param response - The client's response.
 */
export function interpretPermissionResponse(
  response: acp.RequestPermissionResponse,
): PermissionOutcome {
  const outcome = response.outcome

  if (outcome.outcome === 'cancelled') {
    return { allowed: false, cancelled: true }
  }

  switch (outcome.optionId) {
    case 'allow_once':
      return { allowed: true, cancelled: false }
    case 'allow_always':
      return { allowed: true, remember: 'allow', cancelled: false }
    case 'reject_always':
      return { allowed: false, remember: 'deny', cancelled: false }
    case 'reject_once':
    default:
      return { allowed: false, cancelled: false }
  }
}
