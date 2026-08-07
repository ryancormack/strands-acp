import { describe, it, expect } from 'vitest'
import { inferToolKind, extractLocations, mapStopReason, mapToolResultContent } from '../mapping.js'

describe('inferToolKind', () => {
  it.each([
    ['file_read', 'read'],
    ['read_file', 'read'],
    ['cat', 'read'],
    ['file_write', 'edit'],
    ['str_replace_editor', 'edit'],
    ['apply_patch', 'edit'],
    ['create_file', 'edit'],
    ['delete_file', 'delete'],
    ['rm', 'delete'],
    ['move_file', 'move'],
    ['rename', 'move'],
    ['grep', 'search'],
    ['glob', 'search'],
    ['web_search', 'fetch'],
    ['http_request', 'fetch'],
    ['bash', 'execute'],
    ['run_command', 'execute'],
    ['python', 'execute'],
    ['think', 'think'],
  ] as const)('maps %s to %s', (name, expected) => {
    expect(inferToolKind(name)).toBe(expected)
  })

  it("defaults to 'other' rather than 'execute' for unrecognised tools", () => {
    expect(inferToolKind('calculate_tax')).toBe('other')
    expect(inferToolKind('')).toBe('other')
  })

  it('prefers an explicit override over inference', () => {
    expect(inferToolKind('bash', { bash: 'other' })).toBe('other')
    expect(inferToolKind('calculate_tax', { calculate_tax: 'think' })).toBe('think')
  })

  it('prefers the more specific pattern when a name could match several', () => {
    // Contains both 'search' and 'web', and fetch is checked before search.
    expect(inferToolKind('web_search')).toBe('fetch')
    // Contains both 'read' and 'file', edit is checked before read.
    expect(inferToolKind('file_write')).toBe('edit')
  })
})

describe('extractLocations', () => {
  it('extracts a path for file-oriented kinds', () => {
    expect(extractLocations({ path: '/tmp/a.ts' }, 'read')).toEqual([{ path: '/tmp/a.ts' }])
    expect(extractLocations({ file_path: '/tmp/b.ts' }, 'edit')).toEqual([{ path: '/tmp/b.ts' }])
    expect(extractLocations({ filePath: '/tmp/c.ts' }, 'delete')).toEqual([{ path: '/tmp/c.ts' }])
  })

  it('includes a line number when present', () => {
    expect(extractLocations({ path: '/tmp/a.ts', line: 42 }, 'read')).toEqual([
      { path: '/tmp/a.ts', line: 42 },
    ])
  })

  it('does not treat a shell argument as a file reference', () => {
    expect(extractLocations({ path: '/usr/bin' }, 'execute')).toEqual([])
    expect(extractLocations({ path: '/tmp/a.ts' }, 'search')).toEqual([])
  })

  it('returns nothing when there is no recognisable path', () => {
    expect(extractLocations({ query: 'foo' }, 'read')).toEqual([])
    expect(extractLocations(null, 'read')).toEqual([])
    expect(extractLocations('a string', 'read')).toEqual([])
    expect(extractLocations({ path: '' }, 'read')).toEqual([])
  })
})

describe('mapStopReason', () => {
  it('maps ordinary completions to end_turn', () => {
    expect(mapStopReason('endTurn')).toBe('end_turn')
    expect(mapStopReason('toolUse')).toBe('end_turn')
    expect(mapStopReason('stopSequence')).toBe('end_turn')
  })

  it('maps both context-exhaustion reasons to max_tokens', () => {
    expect(mapStopReason('maxTokens')).toBe('max_tokens')
    expect(mapStopReason('modelContextWindowExceeded')).toBe('max_tokens')
  })

  it('maps cancellation directly', () => {
    expect(mapStopReason('cancelled')).toBe('cancelled')
  })

  it('does not report an interrupt as a completed turn', () => {
    // ACP has no stop reason meaning "waiting for a human", but end_turn would
    // tell the client the agent answered when it did not.
    expect(mapStopReason('interrupt')).not.toBe('end_turn')
    expect(mapStopReason('interrupt')).toBe('refusal')
  })

  it('maps filtered content to refusal', () => {
    expect(mapStopReason('contentFiltered')).toBe('refusal')
    expect(mapStopReason('guardrailIntervened')).toBe('refusal')
  })

  it('falls back to end_turn for unknown reasons', () => {
    expect(mapStopReason('somethingNew')).toBe('end_turn')
  })
})

describe('mapToolResultContent', () => {
  it('maps text blocks to ACP content', () => {
    const result = { content: [{ type: 'textBlock', text: 'done' }] }
    expect(mapToolResultContent(result)).toEqual([
      { type: 'content', content: { type: 'text', text: 'done' } },
    ])
  })

  it('skips blocks it cannot represent', () => {
    const result = { content: [{ type: 'somethingElse' }, { type: 'textBlock', text: 'kept' }] }
    expect(mapToolResultContent(result)).toEqual([
      { type: 'content', content: { type: 'text', text: 'kept' } },
    ])
  })

  it('tolerates malformed results', () => {
    expect(mapToolResultContent(null)).toEqual([])
    expect(mapToolResultContent({})).toEqual([])
    expect(mapToolResultContent({ content: 'not an array' })).toEqual([])
  })
})
