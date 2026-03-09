import path from 'path';
import type { InboundMessage, TurnContext, AgentDefinition } from '@/types';
import { checkAllowlist } from './middleware';
import { checkMessageRate } from './rate-limiter';
import { runAgent, loadAgentDefinition, agentRegistry } from './agent';

// ─── Test seam ────────────────────────────────────────────────────────────────
// Allows pipeline tests to capture turns without mock.module pollution.
let _agentRunner: (turn: TurnContext, def: AgentDefinition) => Promise<void> = runAgent;
export function _setAgentRunnerForTest(fn: (turn: TurnContext, def: AgentDefinition) => Promise<void>): void { _agentRunner = fn; }
export function _clearAgentRunnerForTest(): void { _agentRunner = runAgent; }
import { assembleContext } from './assemble';
import { transcribe } from '@/whatsapp/voice';
import { parseFlags, stripFlags } from '@/whatsapp/flags';
import { parseCommand, registry as commandRegistry } from '@/commands';
import { enqueueMessage } from '@/whatsapp/send';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { updateFileMessageId, resolveQuotedMessageId, resolveQuotedMessageFile } from '@/db/write';
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

    // Step 3: Normalize — transcribe voice; images and documents pass through unchanged
    let processedMsg = msg;
    if (msg.media) {
      const { path: filePath, mimeType, fileId } = msg.media;
      if (mimeType.startsWith('audio/')) {
        const transcript = await transcribe(filePath, mimeType);
        if (!(transcript instanceof Error)) {
          processedMsg = {
            ...msg,
            text: transcript,
            media: { ...msg.media, fileId, path: filePath, mimeType, transcription: transcript, voiceCaption: msg.text ?? '' },
          };
        } else {
          log.warn('[pipeline] transcription failed', { chatId: msg.chatId, error: transcript.message });
        }
      }
      // Images and documents: no text enrichment — metadata exposed via message context query
    }

    const rawText = processedMsg.text ?? '';

    // Step 4a: /commands bypass the LLM entirely
    const cmd = parseCommand(processedMsg);
    if (cmd) {
      log.info('[pipeline] command dispatched', { chatId: processedMsg.chatId, command: cmd.name });
      const command = commandRegistry.get(cmd.name);
      if (command) await command.execute(processedMsg, cmd.args);
      return;
    }

    // Step 4b + 5: Parse @agent route, strip routing prefix from text
    const routeMatch = rawText.match(/^@([\w-]+)\s*/);
    const agentName = routeMatch ? routeMatch[1]! : config.defaultAgent;
    const cleanText = routeMatch ? rawText.slice(routeMatch[0].length) : rawText;

    // Parse flags from cleanText BEFORE stripping — strippedText loses the !tokens
    const flags = parseFlags({ ...processedMsg, text: cleanText });
    const strippedText = stripFlags(cleanText);

    // Strip flags and routing prefix from msg text so downstream context sees clean text
    let effectiveMsg: InboundMessage = { ...processedMsg, text: strippedText };

    // Step 6: Resolve agent definition
    let def = agentRegistry.get(agentName);
    if (!def) {
      const promptPath = path.join(AGENTS_DIR, `${agentName}.md`);
      def = await loadAgentDefinition(promptPath);
      agentRegistry.set(def.name, def);
    }
    log.info('[pipeline] routing to agent', { chatId: effectiveMsg.chatId, agent: agentName });

    // Resolve quoted message FK if this is a reply
    let quotedMessageId: string | null = null;
    if (effectiveMsg.quotedMessage) {
      quotedMessageId = await resolveQuotedMessageId(
        effectiveMsg.chatId,
        effectiveMsg.quotedMessage.externalId,
      );
      // Look up image file linked to the quoted message so the agent can see it
      if (quotedMessageId) {
        const quotedMedia = await resolveQuotedMessageFile(quotedMessageId);
        if (quotedMedia) {
          effectiveMsg = {
            ...effectiveMsg,
            quotedMessage: { ...effectiveMsg.quotedMessage, media: quotedMedia },
          };
        }
      }
    }

    // Persist inbound message to conversation history
    const [inserted] = await db.insert(messages).values({
      chatId: effectiveMsg.chatId,
      role: 'user',
      content: effectiveMsg.text ?? null,
      createdAt: effectiveMsg.timestamp,
      externalId: effectiveMsg.id,
      ...(quotedMessageId ? { quotedMessageId } : {}),
    }).returning({ id: messages.id });

    if (effectiveMsg.media?.fileId && inserted?.id) {
      const backfill = await updateFileMessageId(effectiveMsg.media.fileId, inserted.id);
      if (backfill instanceof Error) {
        log.warn('[pipeline] updateFileMessageId failed', { error: backfill.message });
      }
    }

    // Build partial TurnContext for context assembly
    const partialTurn: Omit<TurnContext, 'assembled'> = {
      chatId: effectiveMsg.chatId,
      message: effectiveMsg,
      agent: def,
      flags,
      ...(inserted ? { messageId: inserted.id } : {}),
    };

    // Step 7: Assemble context (all queries in parallel)
    const assembled = await assembleContext(partialTurn);
    log.info('[pipeline] context assembled', { chatId: effectiveMsg.chatId, totalTokens: assembled.totalTokens });

    const turn: TurnContext = { ...partialTurn, assembled };

    // Step 8: Execute agent
    log.info('[pipeline] agent execution started', { chatId: effectiveMsg.chatId, agent: agentName });
    await _agentRunner(turn, def);
    log.info('[pipeline] agent execution completed', { chatId: effectiveMsg.chatId, agent: agentName });
  } catch (err) {
    log.error('[pipeline] unhandled error', {
      chatId: msg.chatId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    if (msg.kind === 'whatsapp') {
      try {
        enqueueMessage({
          chatId: msg.chatId,
          content: 'Something went wrong processing your message. Please try again.',
          dedupKey: `${msg.id}:error`,
        });
      } catch {
        // best-effort; ignore
      }
    }
  }
}
