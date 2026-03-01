import type { InboundMessage, AgentDefinition, AssembledContext, ContextQuery } from '../types';

/**
 * Runs all registered context queries in parallel, enforces the total token budget,
 * and trims lowest-priority results first according to each query's truncate strategy.
 */
export async function assembleContext(
  _msg: InboundMessage,
  _agent: AgentDefinition,
  _queries?: ContextQuery[],
): Promise<AssembledContext> {
  throw new Error('TODO: not implemented');
}
