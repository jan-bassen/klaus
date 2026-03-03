import path from 'path';
import type { InboundMessage, TurnContext } from '@/types';
import { checkAllowlist } from './middleware';
import { checkMessageRate } from './rate-limiter';
import { runAgent, loadAgentDefinition, agentRegistry } from './agent';
import { assembleContext } from './assemble';
import { parseFlags, stripFlags } from '@/whatsapp/flags';
import { parseCommand, registry as commandRegistry } from '@/whatsapp/commands';
import { enqueueMessage } from '@/whatsapp/send';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { config } from '@/config';
import { log } from '@/logger';

const AGENTS_DIR = path.join(import.meta.dir, '..', 'agents');

/**
 * The single orchestrator for all user-initiated messages.
 *
 * Sequence:
 *   1. Auth        → middleware.checkAllowlist
 *   2. Rate check  → rateLimiter.checkMessageRate
 *   3. Normalize   → transcribe voice / analyze image if applicable
 *   4. Parse       → resolve @agent and !flags inline
 *   5. Route       → resolve target AgentDefinition
 *   6. Assemble    → context.assemble (all queries in parallel)
 *   7. Execute     → agent.runAgent
 *   8. Hooks       → dispatch post-turn hooks via queue (async, zero latency impact)
 */
export async function handleTurn(msg: InboundMessage): Promise<void> {
  try {
    // Step 1: Auth
    if (!checkAllowlist(msg).allowed) {
      log.info('[pipeline] auth rejected', { chatId: msg.chatId });
      return;
    }
    log.info('[pipeline] auth ok', { chatId: msg.chatId });

    // Step 2: Rate check
    const rate = checkMessageRate(msg);
    if (!rate.allowed) {
      log.warn('[pipeline] rate limited', { chatId: msg.chatId, retryAfterMs: rate.retryAfterMs });
      enqueueMessage({
        chatId: msg.chatId,
        content: 'Too many messages — please slow down.',
        dedupKey: `${msg.id}:rate-limit`,
      });
      return;
    }

    // Step 3: Normalize — voice/image deferred; text passes through unchanged

    const rawText = msg.text ?? '';

    // Step 4a: /commands bypass the LLM entirely
    const cmd = parseCommand(msg);
    if (cmd) {
      log.info('[pipeline] command dispatched', { chatId: msg.chatId, command: cmd.name });
      const command = commandRegistry.get(cmd.name);
      if (command) await command.execute(msg, cmd.args);
      return;
    }

    // Step 4b + 5: Parse @agent route, strip routing prefix from text
    const routeMatch = rawText.match(/^@([\w-]+)\s*/);
    const agentName = routeMatch ? routeMatch[1]! : config.defaultAgent;
    const cleanText = routeMatch ? rawText.slice(routeMatch[0].length) : rawText;
    const strippedText = stripFlags(cleanText);

    // Strip flags and routing prefix from msg text so downstream context sees clean text
    const effectiveMsg: InboundMessage = { ...msg, text: strippedText };

    // Step 6: Resolve agent definition
    let def = agentRegistry.get(agentName);
    if (!def) {
      const promptPath = path.join(AGENTS_DIR, `${agentName}.md`);
      def = await loadAgentDefinition(promptPath);
      agentRegistry.set(def.name, def);
    }
    log.info('[pipeline] routing to agent', { chatId: effectiveMsg.chatId, agent: agentName });

    // Step 7: Assemble context (all 4 queries in parallel)
    const assembled = await assembleContext(effectiveMsg, def);
    log.info('[pipeline] context assembled', { chatId: effectiveMsg.chatId, totalTokens: assembled.totalTokens });

    // Persist inbound message to conversation history
    const [inserted] = await db.insert(messages).values({
      chatId: effectiveMsg.chatId,
      role: 'user',
      content: effectiveMsg.text ?? null,
      createdAt: effectiveMsg.timestamp,
    }).returning({ id: messages.id });

    // Build TurnContext
    const flags = parseFlags(effectiveMsg);
    const turn: TurnContext = {
      msg: effectiveMsg,
      agent: def,
      flags,
      assembled,
      ...(inserted ? { messageId: inserted.id } : {}),
    };

    // Step 8: Execute agent
    log.info('[pipeline] agent execution started', { chatId: effectiveMsg.chatId, agent: agentName });
    const agentReturn = await runAgent(turn, def);
    log.info('[pipeline] agent execution completed', { chatId: effectiveMsg.chatId, agent: agentName });

    // Step 9: Hooks — fire synchronously for V1 (pg-boss async dispatch deferred)
    for (const hookCfg of def.hooks ?? []) {
      const signal = agentReturn?.hooks?.[hookCfg.signal];
      if (signal?.fire === false) continue;
      log.info('[pipeline] hook dispatched', { chatId: effectiveMsg.chatId, hook: hookCfg.hook });
      const hookDef = agentRegistry.get(hookCfg.hook);
      if (hookDef) await runAgent(turn, hookDef);
    }
  } catch (err) {
    log.error('[pipeline] unhandled error', {
      chatId: msg.chatId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}
