import type { LlmGateway } from '@kaki/llm-gateway';
import { EmbeddingUnavailableError } from './errors.js';
import type { FactInput, VisitorFact } from './types.js';

/** The text embedded for a fact (one chunk per fact until FEAT-012 adds documents). */
export function chunkContent(input: FactInput | VisitorFact): string {
  switch (input.type) {
    case 'product': {
      const unit = input.value.unit ? `, ${input.value.unit}` : '';
      return `${input.value.name}${unit}`;
    }
    case 'faq':
      return `${input.value.question}\n${input.value.answer}`;
    case 'policy':
    case 'promotion':
      return `${input.value.title}\n${input.value.details}`;
  }
}

export interface PreparedChunk {
  content: string;
  embedding: number[];
}

/** Embeds a fact's chunk before its transaction opens (D4). */
export async function prepareChunk(
  llm: LlmGateway,
  tenantId: string,
  input: FactInput,
): Promise<PreparedChunk> {
  const content = chunkContent(input);
  try {
    const { vectors } = await llm.embed({
      texts: [content],
      purpose: 'document',
      meta: { tenantId },
    });
    return { content, embedding: vectors[0]! };
  } catch (err) {
    throw new EmbeddingUnavailableError('embedding failed', { cause: err });
  }
}

/** pgvector literal. */
export const vectorLiteral = (v: number[]) => `[${v.join(',')}]`;
