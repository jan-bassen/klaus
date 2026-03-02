import path from 'path';
import type { InboundMessage, TurnContext } from '@/types';
import { checkAllowlist, debounce } from './middleware';
import { checkMessageRate } from './rate-limiter';
import { runAgent, loadAgentDefinition, agentRegistry } from './agent';
import { assembleContext } from '@/context/assemble';
import { conversationQuery } from '@/context/conversation';
import { flagsQuery } from '@/context/flags';
import { graphContextQuery } from '@/context/graph-context';
import { activeTasksQuery } from '@/context/tasks';
import { toolsQuery } from '@/context/tools';
import { parseFlags, stripFlags } from '@/whatsapp/flags';
import { parseCommand, registry as commandRegistry } from '@/whatsapp/commands';
import { enqueueMessage } from '@/whatsapp/send';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { config } from '@/config';

const ALL_QUERIES = [conversationQuery, flagsQuery, graphContextQuery, activeTasksQuery, toolsQuery];

const AGENTS_DIR = path.join(import.meta.dir, '..', 'agents');

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
export async function handleTurn(msg: InboundMessage): Promise<void> {
  // Step 1: Auth
  if (!checkAllowlist(msg).allowed) return;

  // Step 2: Rate check
  const rate = checkMessageRate(msg);
  if (!rate.allowed) {
    enqueueMessage({
      chatId: msg.chatId,
      content: 'Too many messages — please slow down.',
      dedupKey: `${msg.id}:rate-limit`,
    });
    return;
  }

  // Step 3: Debounce — first caller in a window gets the batch, others skip
  const batch = await debounce(msg);
  if (batch.length === 0) return;
  // Use the most recent message in the burst as the effective message
  const effective = batch[batch.length - 1]!;

  // Step 4: Normalize — voice/image deferred; text passes through unchanged

  const rawText = effective.text ?? '';

  // Step 5a: /commands bypass the LLM entirely
  const cmd = parseCommand(effective);
  if (cmd) {
    const command = commandRegistry.get(cmd.name);
    if (command) await command.execute(effective, cmd.args);
    return;
  }

  // Step 5b + 6: Parse @agent route, strip routing prefix from text
  const routeMatch = rawText.match(/^@([\w-]+)\s*/);
  const agentName = routeMatch ? routeMatch[1]! : config.defaultAgent;
  const cleanText = routeMatch ? rawText.slice(routeMatch[0].length) : rawText;
  const strippedText = stripFlags(cleanText);

  // Mutate effective msg text so downstream context sees the clean text
  const effectiveMsg: InboundMessage = { ...effective, text: strippedText };

  // Step 6: Resolve agent definition
  let def = agentRegistry.get(agentName);
  if (!def) {
    const promptPath = path.join(AGENTS_DIR, `${agentName}.md`);
    def = await loadAgentDefinition(promptPath);
    agentRegistry.set(def.name, def);
  }

  // Step 7: Assemble context (all 5 queries in parallel)
  const assembled = await assembleContext(effectiveMsg, def, ALL_QUERIES);

  // Persist inbound message to conversation history
  await db.insert(messages).values({
    chatId: effectiveMsg.chatId,
    role: 'user',
    content: effectiveMsg.text ?? null,
    createdAt: effectiveMsg.timestamp,
  });

  // Build TurnContext
  const flags = parseFlags(effectiveMsg);
  const turn: TurnContext = { msg: effectiveMsg, agent: def, flags, assembled };

  // Step 8: Execute agent
  const agentReturn = await runAgent(turn, def);

  // Step 9: Hooks — fire synchronously for V1 (pg-boss async dispatch deferred)
  for (const hookCfg of def.hooks ?? []) {
    const signal = agentReturn?.hooks?.[hookCfg.signal];
    if (signal?.fire === false) continue;
    const hookDef = agentRegistry.get(hookCfg.hook);
    if (hookDef) await runAgent(turn, hookDef);
  }
}
