import { TextBlock, ImageBlock } from '@strands-agents/sdk'
import type { ImageFormat } from '@strands-agents/sdk'
import { SUPPORTED_IMAGE_FORMATS } from './mapping.js'

/** The fields of an ACP content block the bridge reads. v1 and v2 share this shape. */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: string }

export type StrandsInput = string | InstanceType<typeof TextBlock | typeof ImageBlock>[]

function extractImageFormat(mimeType: string): ImageFormat {
  const format = mimeType.replace(/^image\//, '')
  if (!(SUPPORTED_IMAGE_FORMATS as readonly string[]).includes(format)) {
    throw new Error(
      `Unsupported image format: '${mimeType}'. Supported formats: ${SUPPORTED_IMAGE_FORMATS.join(', ')}`,
    )
  }
  return format as ImageFormat
}

/**
 * Converts ACP prompt content into Strands invoke args. Text-only prompts become
 * a plain string; anything else becomes content blocks, skipping unknown types.
 */
export function toStrandsInput(prompt: readonly PromptBlock[]): StrandsInput {
  if (prompt.every((c) => c.type === 'text')) {
    return prompt.map((c) => (c as { text: string }).text).join('\n')
  }

  const blocks: InstanceType<typeof TextBlock | typeof ImageBlock>[] = []
  for (const block of prompt) {
    if (block.type === 'text') {
      blocks.push(new TextBlock((block as { text: string }).text))
    } else if (block.type === 'image') {
      const image = block as { mimeType: string; data: string }
      const format = extractImageFormat(image.mimeType)
      blocks.push(new ImageBlock({ format, source: { bytes: Buffer.from(image.data, 'base64') } }))
    }
  }
  if (blocks.length === 0) {
    throw new Error(
      `Prompt contained only unsupported content block types: ${prompt.map((b) => b.type).join(', ')}`,
    )
  }
  return blocks
}
