import type { InboundMessage } from '../types';

/**
 * The single orchestrator for all user-initiated messages.
 *
 * Sequence:
 *   1. Auth        → middleware.checkAllowlist
 *   2. Rate check  → rateLimiter.checkMessageRate
 *   3. Debounce    → middleware.debounce
 *   4. Normalize   → transcribe voice / analyze image if applicable
 *   5. Parse       → resolve @agent and !flags inline
 *   6. Route       → resolve target AgentDefinition
 *   7. Assemble    → context.assemble (all queries in parallel)
 *   8. Execute     → agent.runAgent
 *   9. Hooks       → dispatch post-turn hooks via queue (async, zero latency impact)
 */
export async function handleTurn(_msg: InboundMessage): Promise<void> {
  throw new Error('TODO: not implemented');
}
