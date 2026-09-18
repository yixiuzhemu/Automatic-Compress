/**
 * Agent-callable `compact_context` tool definition.
 *
 * Provides a model-facing entry point for context compaction, enabling
 * AgentTeams leaders to compress their own or sub-agents' sessions.
 * Constructed as a plain `ToolDefinition` object because `dsh-tools` is
 * not a build-time dependency — the harness provides `ctx.tools` at runtime.
 *
 * @module @automatic-compress/automatic-compress/tool
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

/* ---------------------------------------------------------------------------
 * Local type declarations for dsh-tool and compaction vocabulary.
 * These mirror the harness interfaces without importing from packages that
 * are not build-time dependencies of this plugin.
 * --------------------------------------------------------------------------- */

/**
 * Agent shape this tool needs for compaction.
 * Mirrors `ManualCompactAgentContext` from `dsh-compaction`.
 */
export interface ToolAgentContext {
  readonly id: string
  readonly session: unknown
  readonly options?: { provider?: string; model?: string }
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/**
 * Compaction result shape this tool reads.
 * Mirrors `CompactionResult` from `dsh-compaction`.
 */
export interface ToolCompactionResult {
  readonly shadowedSeqs: readonly unknown[]
  readonly shadowedTokenCount: number
}

/**
 * Compaction service interface.
 * Mirrors `CompactionEngine` from `dsh-compaction`.
 */
export interface ToolCompactionService {
  compactNow(
    agent: ToolAgentContext,
    signal: AbortSignal,
  ): Promise<ToolCompactionResult | null>
}

/**
 * Execution context passed to the tool's `execute` function.
 * A subset of `ToolRunContext` from `dsh-tools`.
 */
export interface ToolExecContext {
  readonly agent?: {
    readonly id: string
    readonly ctx?: { readonly [key: string]: unknown }
    readonly [key: string]: unknown
  }
  readonly signal: AbortSignal
  readonly [key: string]: unknown
}

/** One target's compaction outcome in the tool's canonical output. */
export interface CompactTargetResult {
  session_id: string
  status: 'compacted' | 'queued' | 'noop' | 'busy' | 'error'
  shadowed_nodes: number
  tokens_before: number
  tokens_after: number
  detail: string
}

/** Options for constructing the tool definition. */
export interface CompactToolOptions {
  /** The Cordis context for service resolution and event listening. */
  ctx: Context
  /** Resolve the calling agent's owning session id. */
  getSessionId: (agentId: string) => string | undefined
  /** Resolve the calling agent as a compaction-capable context. */
  getAgentContext: (agentId: string) => ToolAgentContext | undefined
  /** Read the current projected token count for a session. */
  getCurrentTokens: (sessionId: string) => number
}

/**
 * Format a number with locale-style thousand separators.
 * Uses a simple regex approach to avoid locale dependencies.
 */
function formatNumber(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Build the `compact_context` tool definition.
 * The returned object matches the `ToolDefinition` shape that
 * `ToolRuntime.register()` expects.
 * @param options - service accessors and context for the tool.
 * @returns a registry-ready tool definition.
 */
export function createCompactToolDefinition(options: CompactToolOptions): {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => ContentBlock[]
  }
  execute: (args: unknown, exec: ToolExecContext) => Promise<{ targets: CompactTargetResult[] }>
  isConcurrencySafe: () => boolean
  presentCall: (args: unknown) => { card: string; title: string; kind: string }
  presentResult: (args: unknown, result: unknown) => { card: string; title: string; content: ContentBlock[] }
} {
  const { ctx, getSessionId, getAgentContext, getCurrentTokens } = options

  return {
    name: 'compact_context',
    description: [
      'Compress the conversation context NOW. Call this tool immediately whenever the user asks to',
      'compress / compact the context or complains that a session is too long — including terse or',
      'colloquial phrasings such as "压一遍", "压缩一下", "压一下上下文", "compact the context",',
      '"free up context". This tool IS that action: do NOT ask a clarifying question first, and do',
      'NOT go looking for a plugin or a settings page. It force-compacts the session, ignoring the',
      'automatic pressure threshold, so the session is reduced even when it is nowhere near the',
      'automatic trigger line. Also call this tool proactively when you notice context is getting',
      'large (e.g. before starting a complex task) to avoid degraded performance.',
      ' The target session must be idle to compact immediately. A session that is mid-turn is',
      ' either queued (the default: it is compacted the moment it next goes idle) or reported as',
      ' `busy`. The CALLING session is always mid-turn while it runs this tool, so it always takes',
      ' the queued path and is compacted at the end of its own turn.',
    ].join(' '),

    parameters: {
      target_session_id: {
        type: 'string',
        description:
          'Session ID to compact. Omit or use "self" for the calling agent\'s own session.',
      },
      when_busy: {
        type: 'string',
        enum: ['queue', 'skip', 'error'],
        description:
          'Behavior when target is busy. Default "queue" waits for idle then compresses.',
      },
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                session_id: { type: 'string' },
                status: { type: 'string', enum: ['compacted', 'queued', 'noop', 'busy', 'error'] },
                shadowed_nodes: { type: 'integer' },
                tokens_before: { type: 'integer' },
                tokens_after: { type: 'integer' },
                detail: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },

      render(_args: unknown, value: unknown): ContentBlock[] {
        const output = value as { targets?: CompactTargetResult[] }
        const targets = output.targets ?? []
        const lines: string[] = []
        for (const t of targets) {
          switch (t.status) {
            case 'compacted':
              lines.push(
                `Session ${t.session_id}: ~${formatNumber(t.tokens_before)} → ~${formatNumber(t.tokens_after)} tokens (${t.shadowed_nodes} nodes compacted)`,
              )
              break
            case 'queued':
              lines.push(`Session ${t.session_id}: queued (waiting for idle)`)
              break
            case 'noop':
              lines.push(`Session ${t.session_id}: nothing to compact`)
              break
            case 'busy':
              lines.push(`Session ${t.session_id}: busy, skipped`)
              break
            case 'error':
              lines.push(`Session ${t.session_id}: error — ${t.detail}`)
              break
          }
        }
        return [{ type: 'text', text: lines.join('\n') || 'No targets processed.' }]
      },
    },

    isConcurrencySafe(): boolean {
      return false
    },

    presentCall(args: unknown) {
      const a = args as { target_session_id?: string } | undefined
      const target = a?.target_session_id
      return {
        card: 'generic',
        title: `Compressing context${target && target !== 'self' ? ` for ${target}` : ''}...`,
        kind: 'other',
      }
    },

    presentResult(_args: unknown, result: unknown) {
      const r = result as { content?: ContentBlock[] } | undefined
      const text = r?.content
        ?.filter((b: ContentBlock) => b.type === 'text')
        .map((b: ContentBlock) => (b as { type: 'text'; text: string }).text)
        .join('') ?? ''
      return {
        card: 'generic',
        title: 'Context compressed',
        content: [{ type: 'text', text: text || 'Done.' }],
      }
    },

    async execute(
      args: unknown,
      exec: ToolExecContext,
    ): Promise<{ targets: CompactTargetResult[] }> {
      const {
        target_session_id,
        when_busy,
      } = args as {
        target_session_id?: string
        when_busy?: 'queue' | 'skip' | 'error'
      }

      const whenBusy = when_busy ?? 'queue'
      const callerAgent = exec.agent
      if (callerAgent === undefined) {
        return {
          targets: [{
            session_id: 'unknown',
            status: 'error',
            shadowed_nodes: 0,
            tokens_before: 0,
            tokens_after: 0,
            detail: 'no calling agent context',
          }],
        }
      }

      // ── Resolve target session id ──
      const callerSessionId = getSessionId(callerAgent.id) ?? callerAgent.id
      const targetId = (!target_session_id || target_session_id === 'self')
        ? callerSessionId
        : target_session_id

      // ── Authorization: sub-agents can only compact their own session ──
      const callerScope = callerAgent.ctx as {
        [key: string]: unknown
      } | undefined
      const isTopLevel = callerScope === undefined
        || callerScope['scope'] === undefined
        || callerScope['scope'] === null

      if (!isTopLevel && targetId !== callerSessionId) {
        return {
          targets: [{
            session_id: targetId,
            status: 'error',
            shadowed_nodes: 0,
            tokens_before: 0,
            tokens_after: 0,
            detail: 'sub-agents can only compact their own session',
          }],
        }
      }

      // ── Resolve target agent context ──
      const targetAgent = getAgentContext(targetId)
      if (targetAgent === undefined) {
        return {
          targets: [{
            session_id: targetId,
            status: 'error',
            shadowed_nodes: 0,
            tokens_before: 0,
            tokens_after: 0,
            detail: 'target agent not found',
          }],
        }
      }

      // ── Resolve compaction service ──
      const compaction = (ctx as unknown as { get: (key: string) => unknown }).get('compaction') as ToolCompactionService | undefined

      if (compaction === undefined) {
        return {
          targets: [{
            session_id: targetId,
            status: 'error',
            shadowed_nodes: 0,
            tokens_before: 0,
            tokens_after: 0,
            detail: 'compaction service not available',
          }],
        }
      }

      const tokensBefore = getCurrentTokens(targetId)

      // ── Perform compaction (with optional busy-queue) ──
      return doCompact(targetAgent, targetId, tokensBefore, whenBusy, exec, ctx, compaction)
    },
  }
}

/**
 * Execute compaction on a target agent, handling the busy-queue policy.
 * @param targetAgent - the agent context to compact.
 * @param targetId - the session identity for reporting.
 * @param tokensBefore - current projected token count.
 * @param whenBusy - queue, skip, or error policy.
 * @param exec - the tool execution context (for signal forwarding).
 * @param ctx - the Cordis context (for event listening).
 * @param compaction - the compaction service.
 * @returns per-target compaction result.
 */
async function doCompact(
  targetAgent: ToolAgentContext,
  targetId: string,
  tokensBefore: number,
  whenBusy: 'queue' | 'skip' | 'error',
  exec: ToolExecContext,
  ctx: Context,
  compaction: ToolCompactionService,
): Promise<{ targets: CompactTargetResult[] }> {
  try {
    const result = await compaction.compactNow(targetAgent, exec.signal)

    if (result === null || result === undefined) {
      return {
        targets: [{
          session_id: targetId,
          status: 'noop',
          shadowed_nodes: 0,
          tokens_before: tokensBefore,
          tokens_after: tokensBefore,
          detail: 'no compactable history',
        }],
      }
    }

    return {
      targets: [{
        session_id: targetId,
        status: 'compacted',
        shadowed_nodes: result.shadowedSeqs.length,
        tokens_before: tokensBefore,
        tokens_after: Math.max(0, tokensBefore - result.shadowedTokenCount),
        detail: `compacted ${result.shadowedSeqs.length} nodes, freed ~${result.shadowedTokenCount} tokens`,
      }],
    }
  } catch (error: unknown) {
    const msg = errorMessage(error)

    // Detect busy error and apply the whenBusy policy.
    if (isBusyError(error)) {
      if (whenBusy === 'skip') {
        return {
          targets: [{
            session_id: targetId,
            status: 'busy',
            shadowed_nodes: 0,
            tokens_before: tokensBefore,
            tokens_after: tokensBefore,
            detail: 'target is busy, skipped',
          }],
        }
      }

      if (whenBusy === 'error') {
        return {
          targets: [{
            session_id: targetId,
            status: 'error',
            shadowed_nodes: 0,
            tokens_before: tokensBefore,
            tokens_after: tokensBefore,
            detail: 'target is busy',
          }],
        }
      }

      // whenBusy === 'queue': wait for idle then retry.
      return waitForIdleAndCompact(targetAgent, targetId, tokensBefore, exec, ctx, compaction)
    }

    return {
      targets: [{
        session_id: targetId,
        status: 'error',
        shadowed_nodes: 0,
        tokens_before: tokensBefore,
        tokens_after: tokensBefore,
        detail: msg,
      }],
    }
  }
}

/**
 * Wait for a busy agent to become idle, then compact it.
 * Listens to `agent/status` events on the Cordis context.
 * @param targetAgent - the agent context to compact.
 * @param targetId - the session identity for reporting.
 * @param tokensBefore - current projected token count.
 * @param exec - the tool execution context.
 * @param ctx - the Cordis context.
 * @param compaction - the compaction service.
 * @returns per-target compaction result after waiting.
 */
async function waitForIdleAndCompact(
  targetAgent: ToolAgentContext,
  targetId: string,
  tokensBefore: number,
  exec: ToolExecContext,
  ctx: Context,
  compaction: ToolCompactionService,
): Promise<{ targets: CompactTargetResult[] }> {
  return new Promise<{ targets: CompactTargetResult[] }>((resolve) => {
    let settled = false

    // Handle cancellation: if the signal aborts while waiting, resolve with error.
    const onAbort = (): void => {
      if (settled) return
      settled = true
      dispose()
      resolve({
        targets: [{
          session_id: targetId,
          status: 'error',
          shadowed_nodes: 0,
          tokens_before: tokensBefore,
          tokens_after: tokensBefore,
          detail: 'cancelled while waiting',
        }],
      })
    }

    const dispose = (ctx as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => () => void
    }).on('agent/status', (payload: unknown) => {
      const p = payload as { agent?: { id: string }; status?: string }
      if (p.agent?.id === targetId && p.status === 'idle') {
        if (settled) return
        dispose()
        exec.signal.removeEventListener('abort', onAbort)

        // Now compact. Re-read tokens for an up-to-date before count.
        doCompact(targetAgent, targetId, tokensBefore, 'error', exec, ctx, compaction)
          .then((result) => {
            if (!settled) {
              settled = true
              // Upgrade status from 'error' to 'queued' for the wait phase.
              for (const t of result.targets) {
                if (t.status === 'compacted') {
                  t.status = 'queued'
                  t.detail = `queued then compacted: ${t.detail}`
                }
              }
              resolve(result)
            }
          })
          .catch((error: unknown) => {
            if (!settled) {
              settled = true
              resolve({
                targets: [{
                  session_id: targetId,
                  status: 'error',
                  shadowed_nodes: 0,
                  tokens_before: tokensBefore,
                  tokens_after: tokensBefore,
                  detail: errorMessage(error),
                }],
              })
            }
          })
      }
    })

    // Listen for cancellation.
    exec.signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Check whether an error represents a busy-agent rejection. */
function isBusyError(error: unknown): boolean {
  if (error instanceof Error) {
    if ('code' in error && (error as { code: unknown }).code === 'busy') return true
    if ('name' in error && (error as { name: unknown }).name === 'ManualCompactionError') {
      return 'code' in error && (error as { code: unknown }).code === 'busy'
    }
    return error.message.toLowerCase().includes('busy')
  }
  return false
}

/** Best-effort error message extraction. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
