import * as acp from '@agentclientprotocol/sdk'

/**
 * Durable storage for ACP-level session metadata.
 *
 * The bridge keeps live sessions in memory, so `session/list` can only ever see
 * sessions created by the running process. A store supplies the durable half:
 * the sessions that exist on disk and are resumable but that this process has
 * not loaded.
 *
 * The caller implements this because the caller owns storage. The bridge is
 * handed an `agentFactory` and never learns where that factory persists
 * anything, and the Strands session layout is not part of its public API.
 *
 * What is stored is exactly {@link acp.SessionInfo}: the protocol's own record.
 * `cwd` and `title` cannot be recovered from a Strands snapshot because they are
 * ACP concepts the agent never sees, which is why a read-only view over
 * snapshots is not sufficient and this interface has a write side.
 */
export interface SessionStore {
  /**
   * Lists persisted sessions.
   *
   * `cwd` is a filter hint, offered so a backend that can narrow the read does
   * not have to fetch everything. Ignoring it is safe: the bridge applies the
   * same filter to whatever comes back, so a lazy implementation is correct,
   * just less efficient.
   */
  list(params: { cwd?: string | null }): Promise<acp.SessionInfo[]>

  /**
   * Records or replaces a session's metadata. Called when a session is created,
   * loaded, resumed, and after each completed turn.
   *
   * Must be idempotent on `sessionId`. Failures are logged and swallowed by the
   * bridge rather than failing the user's turn, so an implementation that needs
   * write failures to be visible has to surface them itself.
   */
  save(info: acp.SessionInfo): Promise<void>

  /**
   * Forgets a session. Optional, and never called by the bridge today:
   * `session/close` drops the session from memory but deliberately leaves the
   * durable record in place, because a closed session is still resumable.
   */
  remove?(sessionId: string): Promise<void>
}

/**
 * Merges live in-memory sessions with persisted ones.
 *
 * A session present in both wins from `live`, which holds the authoritative
 * `cwd` and the current `updatedAt` for a session being used right now. The
 * `cwd` filter is applied to both sides so a store that ignored the hint cannot
 * leak sessions from another directory.
 *
 * Sorted by `updatedAt` descending, so a client rendering a picker gets the most
 * recently used session first. Ties fall back to `sessionId` to keep the order
 * stable across calls.
 *
 * @param live - Sessions held in memory by the running process.
 * @param stored - Sessions returned by a {@link SessionStore}.
 * @param cwd - Optional working-directory filter from the client's request.
 */
export function mergeSessionInfos(
  live: readonly acp.SessionInfo[],
  stored: readonly acp.SessionInfo[],
  cwd?: string | null,
): acp.SessionInfo[] {
  // ACP models an absent cwd as null or undefined; both mean "do not filter".
  const matchesCwd = (info: acp.SessionInfo) =>
    cwd === undefined || cwd === null || normalizePath(info.cwd) === normalizePath(cwd)

  const merged = new Map<string, acp.SessionInfo>()
  for (const info of stored) {
    if (matchesCwd(info)) merged.set(info.sessionId, info)
  }
  // Live entries overwrite stored ones: same id, fresher state.
  for (const info of live) {
    if (matchesCwd(info)) merged.set(info.sessionId, info)
  }

  return [...merged.values()].sort((a, b) => {
    // `updatedAt` is optional in ACP. A session with no timestamp sorts last
    // rather than first, so an unstamped record cannot displace a live one.
    const left = a.updatedAt ?? ''
    const right = b.updatedAt ?? ''
    if (left !== right) return left < right ? 1 : -1
    return a.sessionId < b.sessionId ? -1 : 1
  })
}

/** Normalize a path by stripping trailing slashes (preserving bare '/'). */
function normalizePath(p: string): string {
  return p.replace(/\/+$/, '') || '/'
}

/** Longest title derived from a prompt before it is truncated. */
const TITLE_MAX_LENGTH = 60

/**
 * Derives a human-readable session title from the first user prompt.
 *
 * ACP's `SessionInfo.title` is what a client shows in a session picker, and
 * nothing else in the bridge knows anything human-readable about a session. The
 * first prompt is the only text available at the point a title is first needed.
 *
 * Returns `null` when the prompt carries no usable text, for example an
 * image-only turn, so the caller can leave the title unset rather than invent
 * one.
 *
 * @param blocks - The prompt's content blocks.
 */
export function deriveTitle(blocks: acp.PromptRequest['prompt']): string | null {
  for (const block of blocks) {
    if (block.type !== 'text') continue
    const text = (block as acp.TextContent & { type: 'text' }).text.replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    if (text.length <= TITLE_MAX_LENGTH) return text
    // Prefer a word boundary, but only if it keeps most of the budget; a long
    // first word would otherwise collapse the title to almost nothing.
    const clipped = text.slice(0, TITLE_MAX_LENGTH)
    const lastSpace = clipped.lastIndexOf(' ')
    const cut = lastSpace > TITLE_MAX_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped
    return `${cut.trimEnd()}…`
  }
  return null
}
