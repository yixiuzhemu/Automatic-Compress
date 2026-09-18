/**
 * Automatic context compression plugin: monitors each agent's context usage
 * through the `contextPressure` session projection and provides a client UI
 * for real-time progress display and manual compaction.
 *
 * Automatic compression is handled by dsh's built-in `BasicCompactionEngine`
 * (80% of the model's context window). This plugin only observes and exposes
 * the data for the UI, plus offers a manual "Compact" button.
 *
 * @module @automatic-compress/automatic-compress
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type {
  AutomaticCompressConfig,
  AgentPreStepPayload,
  CompressPhase,
} from './types.js'
import { createCompactToolDefinition } from './tool.js'
import type { ToolAgentContext } from './tool.js'

// Diagnostic: fires immediately on module import to verify the host plugin is loaded.
console.error('[automatic-compress] MODULE LOADED — host plugin entry executed')

export type {
  AutomaticCompressConfig,
  AgentPreStepPayload,
  CompressStatusPayload,
  CompressDonePayload,
  CompressPhase,
  CompressTrigger,
} from './types.js'

/** Default max tokens when no route-specific limit is available. */
const DEFAULT_MAX_TOKENS = 128_000

/** Plugin identity for in-conversation notices (rendered as foldable lines). */
const NOTICE_PLUGIN = 'automatic-compress'

/** Max chars for the notice summary, aligned with the framework's `CONTEXT_SUMMARY_MAX_CHARS`. */
const SUMMARY_MAX_CHARS = 120

/** Text sent when auto-continuing a truncated turn. */
const CONTINUE_TEXT = '继续'

/** Default max auto-continue count per session. */
const DEFAULT_MAX_AUTO_CONTINUES = 2

/**
 * Terminal logger: writes directly to stderr so logs appear in the terminal
 * (including WebStorm Terminal when running under the desktop host).
 * All diagnostic output uses this function instead of `ctx.logger` because
 * the Cordis logger fills a ring buffer that is not visible in the terminal
 * unless an exporter is mounted, which the desktop profile does not do.
 * @param message - log message to write.
 */
function log(message: string): void {
  console.error(`[automatic-compress] ${message}`)
}

/**
 * The subset of `ctx.sessionProjections` this plugin reads.
 * `stateOf()` returns the raw projection state (including `surfaceTokens`),
 * while `snapshot()` returns the client view (only `contextWindow`, etc.).
 * We use `stateOf()` as a fallback data source when `tokenMeter` is
 * unavailable (Path 2/3 in `refreshAndEmit()`).
 */
interface SessionProjectionRegistryService {
  snapshot(session: unknown, keys?: readonly string[]): {
    readonly asOfSeq: number
    readonly values: Record<string, unknown>
  }
  stateOf(session: unknown, key: string): unknown
  onChanged(listener: (session: unknown, key: string, value: unknown, seq: number) => void): () => void
}

/**
 * Client-view of `contextPressure` projection (from `snapshot()`).
 * Only contains `projectedTokens` when both `pressureTokens` and
 * `sampledSurfaceTokens` are defined; otherwise those fields are omitted.
 */
interface ContextPressureView {
  contextWindow?: number
  pressureTokens?: number
  projectedTokens?: number
}

/**
 * Raw `contextPressure` projection state — includes `surfaceTokens`
 * (running surface total) which the client view omits. This is the
 * proven data source for token counts, equivalent to what dsh's bottom
 * status bar displays.
 */
interface ContextPressureState {
  contextWindow?: number
  pressureTokens?: number
  surfaceTokens: number
  sampledSurfaceTokens?: number
}

/**
 * The subset of `ctx.tokenMeter` this plugin reads.
 * `measure(session)` returns the same `totalTokens` that dsh's bottom
 * status bar displays — THE proven data source, used as the primary
 * token count method (Path 1 in `refreshAndEmit()`).
 */
interface TokenMeterService {
  measure(session: unknown): {
    readonly totalTokens: number
    readonly surfaceTokens: number
  }
}

/**
 * The runtime Agent shape this plugin stores for manual compaction.
 * The full runtime Agent (from agent-loop) provides `runMaintenance`,
 * `session`, and `options` that `compaction.compactNow()` requires.
 */
interface RuntimeAgent {
  readonly id: string
  readonly session: unknown
  readonly options?: { provider?: string; model?: string }
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  followup?(message: unknown): void
}

/** Minimal session shape for `session.append()` and `session.id`. */
interface SessionLike {
  readonly id?: string
  append?(type: string, message: unknown, options?: { surfaceOp: string }): void
}

/** Compaction lifecycle event from `session/event`. */
interface CompactionEvent {
  readonly type: 'compaction/start' | 'compaction/summary' | 'compaction/end'
  readonly data: {
    readonly compactionId?: string | number
    readonly shadowedSeqs?: readonly unknown[]
    readonly shadowedTokenCount?: number
    readonly error?: string
    readonly turn?: unknown
    readonly sourceCommandId?: string
  }
}

/** `turn/end` event carrying the termination reason. */
interface TurnEndEvent {
  readonly type: 'turn/end'
  readonly data: {
    readonly reason?: { readonly kind?: string }
  }
}

/**
 * Compression status snapshot returned by the `getStatus` Remote method.
 * The client reads this on mount and after each forwarded event.
 */
export interface CompressStatusSnapshot {
  /** Whether the monitor is actively watching a session. */
  active: boolean
  /** Current lifecycle phase. */
  phase: CompressPhase
  /** Current context usage as a percentage (0–100). */
  usagePercent: number
  /** Estimated current token count. */
  currentTokens: number
  /** The real model context window, or fallback default. */
  maxTokens: number
  /** Last compression outcome, if any. */
  lastOutcome: 'success' | 'skipped' | 'error' | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host service that monitors and displays context usage. */
    automaticCompress: AutomaticCompress
  }
}

/**
 * Host service that monitors agent context usage through the session
 * projection system and provides a client UI for real-time progress
 * display and manual compaction.
 *
 * Automatic compression is delegated to dsh's built-in compaction engine.
 * This service only observes and reports.
 */
export class AutomaticCompress extends TypertRemoteService {
  /**
   * Declare `sessionProjections` as a formal dependency, exactly like
   * dsh's own `TokenMeter` and `session-stats` plugins do. cordis waits
   * for every `inject` entry to become available before constructing the
   * service, so `ctx.sessionProjections` is guaranteed resolvable here.
   * `tokenMeter` is optional: it depends on `sessionProjections` itself,
   * so when `sessionProjections` is ready, `tokenMeter` may or may not
   * be loaded yet; we resolve it non-strict in the constructor.
   */
  static inject = ['sessionProjections'] as const

  /**
   * Plugin config schema. The literal stays in this entry file because
   * `gen-config-catalog` walks a plugin's schema from there.
   */
  static Config = z.object({
    enabled: z.boolean().default(true),
    toolName: z.string().default('compact_context'),
    registerTool: z.boolean().default(true),
    notice: z.boolean().default(true),
    maxAutoContinues: z.number().default(2),
  }) as unknown as z<AutomaticCompressConfig>

  /** The resolved configuration. */
  private readonly config: AutomaticCompressConfig
  /** The Cordis context. */
  private readonly selfCtx: Context
  /** Tracks which sessions are currently being compressed to avoid re-entry. */
  private readonly compressing = new Set<string>()
  /** Latest status for the `getStatus` Remote method. */
  private latestPhase: CompressPhase = 'idle'
  private latestUsagePercent = 0
  private latestCurrentTokens = 0
  private latestOutcome: CompressStatusSnapshot['lastOutcome']
  /** The most recently seen session id, updated on every pre-step. */
  private latestSessionId: string | undefined
  /** The most recently seen Session object, for projection reads.
   *  IMPORTANT: this is updated from BOTH `agent/pre-step` (for agent ref) and
   *  `session/event` (for the canonical projection-registry session reference).
   *  The projection registry keys sessions by object identity in a WeakMap,
   *  so we MUST use the exact same reference from `session/event` for `stateOf()`. */
  private latestSessionRef: unknown
  /** The session reference from `session/event` — the canonical reference
   *  that the projection registry uses as its WeakMap key. This may differ
   *  from `agent.session` in `agent/pre-step`. */
  private canonicalSessionRef: unknown
  /** The most recently seen runtime Agent, for manual compaction. */
  private latestAgentRef: RuntimeAgent | undefined
  /** The real model context window from the `contextPressure` projection. */
  private latestContextWindow: number | undefined
  /** In-flight compactions: compactionId -> { before } token count. */
  private readonly inFlight = new Map<string, { before: number | null }>()
  /** Summaries received but not yet ended: compactionId -> { nodes, tokens }. */
  private readonly summaries = new Map<string, { nodes: number | null; tokens: number | null }>()
  /** Per-session auto-continue counter; reset on normal turn end. */
  private readonly autoContinues = new Map<unknown, number>()
  /** Cached `sessionProjections` service reference (resolved once in constructor).
   *  IMPORTANT: cordis `ctx.get()` is fiber-scoped; calling it from event handlers
   *  may return undefined even when the service exists. Cache the reference. */
  private sessionProjections: SessionProjectionRegistryService | undefined
  /** Cached `tokenMeter` service reference (resolved once in constructor). */
  private tokenMeter: TokenMeterService | undefined
  /** Diagnostic: how many `session/event` calls have been processed. */
  private sessionEventCount = 0
  /** Diagnostic: how many `refreshAndEmit()` calls produced usable data. */
  private successfulRefreshCount = 0

  /**
   * Register the `compress` Remote namespace, the pre-step session tracker,
   * and the projection change listener.
   * @param ctx - Host context.
   * @param config - resolved plugin config.
   */
  constructor(ctx: Context, config: AutomaticCompressConfig) {
    super(ctx, 'automaticCompress', { namespace: 'compress' })
    this.selfCtx = ctx
    this.config = {
      enabled: config.enabled ?? true,
      toolName: config.toolName ?? 'compact_context',
      registerTool: config.registerTool ?? true,
      notice: config.notice ?? true,
      maxAutoContinues: config.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES,
    }

    log(`constructor: enabled=${this.config.enabled}`)

    if (!this.config.enabled) {
      log('plugin is disabled, no monitoring will occur')
      return
    }

    // Hook into the agent/pre-step waterfall ONLY to track the current
    // session and agent reference. Automatic compression is handled by
    // dsh's built-in BasicCompactionEngine (80% of contextWindow).
    ctx.on('agent/pre-step', async (payload: AgentPreStepPayload, next: () => Promise<unknown>) => {
      log(`agent/pre-step fired — agentId=${payload.agent.id} agentStatus=${payload.agent.status}`)
      this.trackSession(payload)
      return next()
    })

    // Resolve service references.
    //
    // `sessionProjections` is a declared dependency (static inject), so
    // cordis guarantees it is available on `ctx` before this constructor
    // runs — matching the exact pattern used by dsh's own TokenMeter and
    // session-stats plugins. `tokenMeter` is resolved non-strict as an
    // optional fallback: it may not yet be loaded when this service starts.
    this.sessionProjections = ctx.get('sessionProjections', false) as SessionProjectionRegistryService | undefined
    this.tokenMeter = ctx.get('tokenMeter', false) as TokenMeterService | undefined

    log(
      `service resolution: sessionProjections=${this.sessionProjections !== undefined}, tokenMeter=${this.tokenMeter !== undefined}`,
    )

    // Set up the projection change listener now that sessionProjections is available.
    this.setupProjectionMonitoring(ctx)

    // Listen for session events to update token counts, broadcast compaction
    // notices, and auto-continue truncated turns.
    //
    // IMPORTANT: In desktop/Web profiles the agent loop may be relocated or
    // disabled (see `cordis.patch.yml`), so `agent/pre-step` might never fire
    // or fire later than expected. This handler must therefore be self-
    // sufficient: it lazily initializes session tracking from the first
    // `session/event` it sees, and no longer depends on `agent/pre-step`.
    ctx.on('session/event', (session: unknown, event: unknown) => {
      const eventType = (event as { type?: string } | null)?.type
      const sessionId = (session as { id?: string } | null)?.id
      this.sessionEventCount++

      // Diagnostic: log the first few session events to verify the handler fires.
      if (this.sessionEventCount <= 5) {
        log(
          `session/event #${this.sessionEventCount} type=${eventType ?? '?'}`
          + ` sessionId=${sessionId ?? '?'}`
          + ` hasSP=${this.sessionProjections !== undefined} hasTM=${this.tokenMeter !== undefined}`
          + ` trackedSession=${this.latestSessionId ?? 'none'}`,
        )
      }

      // Lazy session tracking initialization.
      // If `agent/pre-step` hasn't fired yet (or never will in this profile),
      // pick up the session identity from the first `session/event`.
      if (this.latestSessionId === undefined && sessionId !== undefined) {
        this.latestSessionId = sessionId
        this.latestSessionRef = session
        this.canonicalSessionRef = session
        log(`session tracking initialized from session/event (id=${sessionId})`)
        // Diagnostic: try an immediate projection read to verify data availability.
        this.diagnoseProjectionRead(session)
        // Trigger an immediate status refresh now that we have a session.
        this.refreshAndEmit()
      }

      // Capture the canonical session reference from `session/event`.
      // The projection registry uses this exact object as its WeakMap key,
      // so `stateOf()` only works with THIS reference, not `agent.session`.
      if (sessionId !== undefined && sessionId === this.latestSessionId) {
        this.canonicalSessionRef = session
      }

      // Token count refresh (only for the tracked session).
      if (
        (session === this.latestSessionRef || session === this.canonicalSessionRef)
        && this.latestSessionId !== undefined
      ) {
        this.refreshAndEmit()

        // After a turn ends, the projection state (surfaceTokens) may not
        // have been updated yet. Schedule a delayed re-read so the client
        // receives the final token count once the projection catches up.
        if (eventType === 'turn/end') {
          setTimeout(() => this.refreshAndEmit(), 300)
          setTimeout(() => this.refreshAndEmit(), 1000)
        }
      }
      // Compaction lifecycle notices.
      if (this.config.notice && (eventType === 'compaction/start' || eventType === 'compaction/summary' || eventType === 'compaction/end')) {
        this.noticeFor(session as SessionLike, event as CompactionEvent)
      }
      // Auto-continue on output truncation.
      const maxContinues = this.config.maxAutoContinues ?? 0
      if (maxContinues > 0 && eventType === 'turn/end') {
        this.continueFor(session as SessionLike, event as TurnEndEvent, maxContinues)
      }
    })

    // Register the agent-callable compact_context tool.
    // Silently degrades when ctx.tools is not available.
    if (this.config.registerTool) {
      this.registerTool()
    }
  }

  /**
   * Return the current compression status snapshot. Called by the client
   * through the `compress` Remote namespace on mount and after events.
   * @returns the current status snapshot.
   */
  @Remote
  getStatus(): CompressStatusSnapshot {
    const result = {
      active: this.config.enabled,
      phase: this.latestPhase,
      usagePercent: this.latestUsagePercent,
      currentTokens: this.latestCurrentTokens,
      maxTokens: this.latestContextWindow ?? DEFAULT_MAX_TOKENS,
      lastOutcome: this.latestOutcome,
    }
    log(`getStatus() called by client — returning: ${JSON.stringify(result)}`)
    return result
  }

  /**
   * Manually trigger one idle-session compaction for the current session.
   * Called by the client through the `compress` Remote namespace when the
   * user clicks the "Compact" button in the tooltip.
   * @returns the outcome of the compaction attempt.
   */
  @Remote
  async compactNow(): Promise<{ outcome: 'success' | 'skipped' | 'error'; detail?: string }> {
    const agent = this.latestAgentRef
    const sessionId = this.latestSessionId
    if (agent === undefined || sessionId === undefined) {
      return { outcome: 'error', detail: 'no active session' }
    }
    if (this.compressing.has(sessionId)) {
      return { outcome: 'skipped', detail: 'already compressing' }
    }

    // Resolve the compaction service at runtime (may not be available).
    const compaction = this.selfCtx.get('compaction') as {
      compactNow(agent: unknown, signal: AbortSignal): Promise<unknown>
    } | undefined

    if (compaction === undefined) {
      return { outcome: 'error', detail: 'compaction service not available' }
    }

    this.compressing.add(sessionId)
    this.latestPhase = 'compressing'
    this.emitStatus(sessionId, 'compressing', this.latestUsagePercent, this.latestCurrentTokens)

    try {
      const signal = new AbortController().signal
      const result = await compaction.compactNow(agent, signal)

      if (result !== null && result !== undefined) {
        log(`manual compaction completed for session ${sessionId}`)
        this.latestOutcome = 'success'
        this.selfCtx.emit('automatic-compress/done', {
          sessionId,
          outcome: 'success',
        })
        return { outcome: 'success' }
      } else {
        log(`manual compaction skipped for session ${sessionId}`)
        this.latestOutcome = 'skipped'
        this.selfCtx.emit('automatic-compress/done', {
          sessionId,
          outcome: 'skipped',
        })
        return { outcome: 'skipped' }
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      log(`manual compaction failed for session ${sessionId}`)
      this.latestOutcome = 'error'
      this.selfCtx.emit('automatic-compress/done', {
        sessionId,
        outcome: 'error',
        detail,
      })
      return { outcome: 'error', detail }
    } finally {
      this.compressing.delete(sessionId)
      this.latestPhase = 'idle'
    }
  }

  /**
   * Format a token count with locale-style thousand separators.
   * @param value - token count.
   * @returns e.g. `213,400`.
   */
  private static group(value: number): string {
    return value.toLocaleString('en-US')
  }

  /**
   * Read a session's current surface token estimate via `tokenMeter`.
   * Uses non-strict `ctx.get('tokenMeter', false)` to bypass fiber-scope issues.
   * @param session - the session to measure.
   * @returns the estimated total, or null when the meter is unavailable.
   */
  private measureTokens(session: unknown): number | null {
    try {
      // Use the cached tokenMeter reference (resolved in constructor).
      if (this.tokenMeter === undefined) return null
      const measurement = this.tokenMeter.measure(session)
      const total = measurement.totalTokens
      return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null
    } catch {
      return null
    }
  }

  /**
   * Append a plugin-sourced notice to the session surface. The client renders
   * it as a foldable "context injection" line, not a user bubble.
   * @param session - target session.
   * @param summary - one-line summary for the collapsed state.
   * @param body - expanded body text.
   */
  private appendNotice(session: SessionLike, summary: string, body: string): void {
    if (typeof session.append !== 'function') return
    const bounded = summary.length <= SUMMARY_MAX_CHARS ? summary : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}\u2026`
    try {
      session.append('user/message', {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: 'plugin', plugin: NOTICE_PLUGIN, form: 'notice', summary: bounded },
      }, { surfaceOp: 'append' })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log(`automatic-compress: could not append notice: ${msg}`)
    }
  }

  /**
   * Translate a compaction lifecycle event into a visible notice.
   * @param session - the session the event belongs to.
   * @param event - the compaction event.
   */
  private noticeFor(session: SessionLike, event: CompactionEvent): void {
    const id = String(event.data.compactionId ?? '')
    if (event.type === 'compaction/start') {
      const before = this.measureTokens(session)
      this.inFlight.set(id, { before })
      this.appendNotice(
        session,
        before === null ? '\u6b63\u5728\u538b\u7f29\u4e0a\u4e0b\u6587\u2026' : `\u6b63\u5728\u538b\u7f29\u4e0a\u4e0b\u6587\u2026\uff08\u5f53\u524d ${AutomaticCompress.group(before)} tokens\uff09`,
        '\u23f3 \u4e0a\u4e0b\u6587\u5df2\u8fbe\u538b\u7f29\u9608\u503c\uff0c\u6b63\u5728\u538b\u7f29\u4e0a\u4e0b\u6587\u3002\n'
        + (before === null ? '' : `\u5f53\u524d\u7ea6 ${AutomaticCompress.group(before)} tokens\u3002\n`)
        + '\u8fd9\u662f\u4e00\u6761\u72b6\u6001\u63d0\u793a\uff0c\u4e0d\u9700\u8981\u56de\u5e94\u3002',
      )
      return
    }
    if (event.type === 'compaction/summary') {
      this.summaries.set(id, {
        nodes: Array.isArray(event.data.shadowedSeqs) ? event.data.shadowedSeqs.length : null,
        tokens: typeof event.data.shadowedTokenCount === 'number' ? event.data.shadowedTokenCount : null,
      })
      return
    }
    // compaction/end
    const before = this.inFlight.get(id)?.before ?? null
    this.inFlight.delete(id)
    const stat = this.summaries.get(id) ?? { nodes: null, tokens: null }
    this.summaries.delete(id)
    const failure = typeof event.data.error === 'string' && event.data.error !== '' ? event.data.error : null
    if (failure !== null) {
      this.appendNotice(
        session,
        '\u4e0a\u4e0b\u6587\u538b\u7f29\u672a\u5b8c\u6210',
        `\u26a0\ufe0f \u4e0a\u4e0b\u6587\u538b\u7f29\u672a\u5b8c\u6210\uff1a${failure}\n\u8fd9\u662f\u4e00\u6761\u72b6\u6001\u63d0\u793a\uff0c\u4e0d\u9700\u8981\u56de\u5e94\u3002`,
      )
      return
    }
    const after = this.measureTokens(session)
    const detail = stat.nodes === null ? '' : `\uff0c\u5df2\u906e\u853d ${stat.nodes} \u4e2a\u5386\u53f2\u8282\u70b9`
    const size = before !== null && after !== null
      ? `\u7ea6 ${AutomaticCompress.group(before)} \u2192 ${AutomaticCompress.group(after)} tokens`
      : stat.tokens === null ? '' : `\u5df2\u906e\u853d\u7ea6 ${AutomaticCompress.group(stat.tokens)} tokens`
    this.appendNotice(
      session,
      size === null || size === '' ? `\u4e0a\u4e0b\u6587\u538b\u7f29\u5b8c\u6210${detail}` : `\u4e0a\u4e0b\u6587\u538b\u7f29\u5b8c\u6210\uff1a${size}${detail}`,
      '\u2705 \u4e0a\u4e0b\u6587\u538b\u7f29\u5b8c\u6210\u3002\n'
      + (size === null || size === '' ? '' : `${size}${detail}\u3002\n`)
      + '\u8fd9\u662f\u4e00\u6761\u72b6\u6001\u63d0\u793a\uff0c\u4e0d\u9700\u8981\u56de\u5e94\u3002',
    )
  }

  /**
   * Find the live agent for a session.
   * @param session - the session to look up.
   * @returns the agent, or null.
   */
  private agentForSession(session: SessionLike): RuntimeAgent | null {
    try {
      const agents = this.selfCtx.get('agents') as {
        list?(): RuntimeAgent[]
      } | undefined
      const list = agents?.list?.() ?? []
      return list.find(a => a?.session === session)
        ?? list.find(a => session?.id !== undefined && a?.session !== undefined && (a.session as { id?: string }).id === session.id)
        ?? null
    } catch {
      return null
    }
  }

  /**
   * Auto-continue a turn that was truncated by the output token limit.
   * Sends a follow-up "继续" message via the agent's `followup()` method.
   * @param session - the session whose turn ended.
   * @param event - the `turn/end` event.
   * @param max - maximum auto-continue count for this session.
   */
  private continueFor(session: SessionLike, event: TurnEndEvent, max: number): void {
    if (event.data?.reason?.kind !== 'max-tokens') {
      this.autoContinues.delete(session)
      return
    }
    const agent = this.agentForSession(session)
    if (agent === null || typeof agent.followup !== 'function') return
    const used = (this.autoContinues.get(session) ?? 0) + 1
    this.autoContinues.set(session, used)
    if (used > max) {
      if (this.config.notice) {
        this.appendNotice(
          session,
          `\u8fde\u7eed ${max} \u6b21\u88ab\u8f93\u51fa\u4e0a\u9650\u622a\u65ad\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u7eed\u5199`,
          `\u26a0\ufe0f \u8fde\u7eed ${max} \u8f6e\u90fd\u56e0\u8f93\u51fa token \u4e0a\u9650\u88ab\u622a\u65ad\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u7eed\u5199\uff0c\u907f\u514d\u7ee7\u7eed\u6d88\u8017\u3002\n`
          + '\u8bf7\u624b\u52a8\u53d1\u9001\u201c\u7ee7\u7eed\u201d\uff0c\u6216\u8c03\u5927\u8f93\u51fa\u9884\u7b97\u3002\n'
          + '\u8fd9\u662f\u4e00\u6761\u72b6\u6001\u63d0\u793a\uff0c\u4e0d\u9700\u8981\u56de\u5e94\u3002',
        )
      }
      return
    }
    // Send the follow-up message after the current event dispatch.
    const followupMessage = Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: Object.freeze([Object.freeze({ type: 'text', text: CONTINUE_TEXT })]),
      source: Object.freeze({ kind: 'user' }),
    })
    setTimeout(() => {
      try { agent.followup!(followupMessage) } catch { /* non-fatal */ }
    }, 0)
    if (this.config.notice) {
      this.appendNotice(
        session,
        `\u4e0a\u4e00\u8f6e\u88ab\u8f93\u51fa\u4e0a\u9650\u622a\u65ad\uff0c\u5df2\u81ea\u52a8\u7eed\u5199\uff08${used}/${max}\uff09`,
        `\u23e9 \u4e0a\u4e00\u8f6e\u56e0\u8f93\u51fa token \u4e0a\u9650\u88ab\u622a\u65ad\uff0c\u5df2\u81ea\u52a8\u66ff\u4f60\u53d1\u9001\u201c\u7ee7\u7eed\u201d\uff08\u7b2c ${used}/${max} \u6b21\uff09\u3002\n`
        + '\u8fd9\u662f\u4e00\u6761\u72b6\u6001\u63d0\u793a\uff0c\u4e0d\u9700\u8981\u56de\u5e94\u3002',
      )
    }
  }

  /**
   * Register the `compact_context` agent tool with the tool registry.
   * Silently degrades when `ctx.tools` is not available.
   */
  private registerTool(): void {
    try {
      const tools = this.selfCtx.get('tools') as {
        register(definition: unknown): () => void
      } | undefined
      if (tools === undefined) {
        log('automatic-compress: ctx.tools not available, agent tool not registered')
        return
      }

      const definition = createCompactToolDefinition({
        ctx: this.selfCtx,
        getSessionId: (agentId: string) => {
          if (agentId === this.latestAgentRef?.id) return this.latestSessionId
          return agentId
        },
        getAgentContext: (targetId: string): ToolAgentContext | undefined => {
          // For the calling agent's own session, use the tracked reference.
          if (targetId === this.latestSessionId && this.latestAgentRef !== undefined) {
            return this.latestAgentRef
          }
          // For other sessions, try the agents service.
          const agents = this.selfCtx.get('agents') as {
            get?(id: string): unknown
            find?(predicate: (a: RuntimeAgent) => boolean): RuntimeAgent | undefined
          } | undefined
          if (agents !== undefined) {
            if (typeof agents.find === 'function') {
              return agents.find(a => a.id === targetId) as ToolAgentContext | undefined
            }
            if (typeof agents.get === 'function') {
              return agents.get(targetId) as ToolAgentContext | undefined
            }
          }
          return undefined
        },
        getCurrentTokens: (_sessionId: string): number => {
          return this.latestCurrentTokens
        },
      })

      // Override name if configured.
      if (this.config.toolName && this.config.toolName !== 'compact_context') {
        (definition as { name: string }).name = this.config.toolName
      }

      tools.register(definition)
      log(`automatic-compress: agent tool "${this.config.toolName}" registered`)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      log(`automatic-compress: failed to register agent tool: ${detail}`)
    }
  }

  /**
   * Track the current session from the pre-step payload. Stores the session
   * reference for projection reads and the runtime Agent for manual compaction.
   * Also reads the projection state for an immediate status update.
   * @param payload - the pre-step waterfall payload.
   */
  private trackSession(payload: AgentPreStepPayload): void {
    const { agent } = payload
    this.latestSessionId = agent.id
    this.latestSessionRef = agent.session
    this.latestAgentRef = agent as unknown as RuntimeAgent

    // Read contextWindow from the contextPressure projection state.
    // Use the cached sessionProjections reference (resolved in constructor).
    if (this.latestContextWindow === undefined && this.sessionProjections !== undefined) {
      try {
        const state = this.sessionProjections.stateOf(agent.session, 'contextPressure') as ContextPressureState | undefined
        if (state?.contextWindow !== undefined) {
          this.latestContextWindow = state.contextWindow
        }
      } catch {
        // Non-fatal: projection read failure does not block the step.
      }
    }

    // Read current token state from the projection.
    this.refreshAndEmit()
  }

  /**
   * Set up the `onChanged` listener for projection updates.
   * Called once the `sessionProjections` service is resolved (either immediately
   * or via `ctx.inject()` deferred resolution).
   * @param ctx - the cordis context for logging.
   */
  private setupProjectionMonitoring(ctx: Context): void {
    if (this.sessionProjections !== undefined) {
      this.sessionProjections.onChanged((session, key, value, seq) => {
        log(`[AC] onChanged fired — key=${key} seq=${seq} value=${JSON.stringify(value)}`)
        if (key !== 'contextPressure') return
        // Match by either the tracked ref or the canonical session ref.
        if (session !== this.latestSessionRef && session !== this.canonicalSessionRef) {
          log(`[AC] onChanged: session ref mismatch — skipping`)
          return
        }
        if (this.latestSessionId !== undefined) {
          this.refreshAndEmit()
        }
      })
      log('[AC] projection change listener registered via sessionProjections.onChanged()')
    } else {
      log('[AC] sessionProjections UNAVAILABLE — token monitoring DISABLED')
    }
  }

  /**
   * Diagnostic: attempt a projection read and log the result.
   * Called once when the session is first identified, to verify early
   * whether the data pipeline works.
   * @param session - the session object from `session/event`.
   */
  private diagnoseProjectionRead(session: unknown): void {
    if (this.sessionProjections === undefined) {
      log('[AC] [diag] sessionProjections unavailable — cannot read projections')
      return
    }
    try {
      const state = this.sessionProjections.stateOf(session, 'contextPressure') as ContextPressureState | undefined
      log(
        `[AC] [diag] stateOf(contextPressure) = ${state !== undefined ? JSON.stringify(state) : 'undefined'}`,
      )
      if (state !== undefined) {
        const snap = this.sessionProjections.snapshot(session, ['contextPressure'])
        log(
          `[AC] [diag] snapshot(contextPressure) = ${JSON.stringify(snap?.values?.contextPressure ?? 'undefined')}`,
        )
      }
    } catch (error) {
      log(`[AC] [diag] projection read failed: ${String(error)}`)
    }
    if (this.tokenMeter !== undefined) {
      try {
        const measurement = this.tokenMeter.measure(session)
        log(
          `[AC] [diag] tokenMeter.measure() = totalTokens=${measurement.totalTokens} surfaceTokens=${measurement.surfaceTokens}`,
        )
      } catch (error) {
        log(`[AC] [diag] tokenMeter.measure() failed: ${String(error)}`)
      }
    } else {
      log('[AC] [diag] tokenMeter unavailable')
    }
  }

  /**
   * Re-read token usage and emit a status update.
   *
   * Data resolution order mirrors dsh's own bottom status bar:
   * 1. `tokenMeter.measure(session)` — THE proven data source, identical to
   *    what dsh's status bar displays. Always consistent with the session
   *    surface because it replays the live message projection.
   * 2. `stateOf(canonicalSessionRef, 'contextPressure')` — raw projection
   *    state with `surfaceTokens`, used as fallback when tokenMeter is
   *    unavailable.
   * 3. `snapshot(canonicalSessionRef, ['contextPressure'])` — client view
   *    with `projectedTokens`, last resort.
   *
   * Uses cached service references resolved in the constructor.
   */
  private refreshAndEmit(): void {
    if (this.latestSessionId === undefined) {
      log('[AC] refreshAndEmit: SKIP — no sessionId yet')
      return
    }

    const sessionForRead = this.canonicalSessionRef ?? this.latestSessionRef
    if (sessionForRead === undefined) {
      log('[AC] refreshAndEmit: SKIP — no session ref')
      return
    }

    log(
      `[AC] refreshAndEmit: sessionId=${this.latestSessionId}`
      + ` hasSP=${this.sessionProjections !== undefined} hasTM=${this.tokenMeter !== undefined}`
      + ` sessionRef=${this.canonicalSessionRef !== undefined ? 'canonical' : this.latestSessionRef !== undefined ? 'agent' : 'none'}`,
    )

    // Path 1: `tokenMeter.measure()` — dsh's own status bar data source.
    // This is THE proven source: it replays the session surface and returns
    // the exact `totalTokens` the bottom bar displays. Always try first.
    if (this.tokenMeter !== undefined) {
      try {
        const measurement = this.tokenMeter.measure(sessionForRead)
        log(`[AC] Path1 tokenMeter.measure() = totalTokens=${measurement.totalTokens} surfaceTokens=${measurement.surfaceTokens}`)
        if (measurement.totalTokens > 0) {
          this.latestCurrentTokens = measurement.totalTokens
          const maxTokens = this.latestContextWindow ?? DEFAULT_MAX_TOKENS
          this.latestUsagePercent = maxTokens > 0 ? Math.round((this.latestCurrentTokens / maxTokens) * 100) : 0
          log(`[AC] Path1 HIT: ${measurement.totalTokens} tokens, ${this.latestUsagePercent}% of ${maxTokens}`)
          this.emitStatus(this.latestSessionId, this.latestPhase, this.latestUsagePercent, this.latestCurrentTokens)
          this.successfulRefreshCount++
          return
        }
      } catch (e) {
        log(`[AC] Path1 FAILED: ${String(e)}`)
      }
    } else {
      log('[AC] Path1 SKIP: tokenMeter is undefined')
    }

    // Path 2: raw projection state via `stateOf()` — fallback when tokenMeter
    // is unavailable or returned zero.
    if (this.sessionProjections !== undefined) {
      try {
        const state = this.sessionProjections.stateOf(sessionForRead, 'contextPressure') as ContextPressureState | undefined
        log(`[AC] Path2 stateOf() = ${state !== undefined ? JSON.stringify(state) : 'undefined'}`)
        if (state !== undefined) {
          if (state.contextWindow !== undefined) {
            this.latestContextWindow = state.contextWindow
          }
          let currentTokens: number
          if (state.pressureTokens !== undefined && state.sampledSurfaceTokens !== undefined) {
            currentTokens = Math.max(0, state.pressureTokens + state.surfaceTokens - state.sampledSurfaceTokens)
          } else {
            currentTokens = state.surfaceTokens
          }
          log(`[AC] Path2: surfaceTokens=${state.surfaceTokens} pressureTokens=${state.pressureTokens ?? 'undef'} sampledSurfaceTokens=${state.sampledSurfaceTokens ?? 'undef'} → currentTokens=${currentTokens}`)
          if (currentTokens > 0) {
            this.latestCurrentTokens = currentTokens
            const maxTokens = this.latestContextWindow ?? DEFAULT_MAX_TOKENS
            this.latestUsagePercent = maxTokens > 0 ? Math.round((currentTokens / maxTokens) * 100) : 0
            log(`[AC] Path2 HIT: ${currentTokens} tokens, ${this.latestUsagePercent}% of ${maxTokens}`)
            this.emitStatus(this.latestSessionId, this.latestPhase, this.latestUsagePercent, this.latestCurrentTokens)
            this.successfulRefreshCount++
            return
          }
        }
      } catch (e) {
        log(`[AC] Path2 FAILED: ${String(e)}`)
      }

      // Path 3: client view via `snapshot()` — last resort.
      try {
        const snap = this.sessionProjections!.snapshot(sessionForRead, ['contextPressure'])
        const view = snap?.values?.contextPressure as ContextPressureView | undefined
        log(`[AC] Path3 snapshot() = ${view !== undefined ? JSON.stringify(view) : 'undefined'}`)
        if (view !== undefined) {
          if (view.contextWindow !== undefined) {
            this.latestContextWindow = view.contextWindow
          }
          const currentTokens = view.projectedTokens
          if (typeof currentTokens === 'number' && currentTokens > 0) {
            this.latestCurrentTokens = currentTokens
            const maxTokens = this.latestContextWindow ?? DEFAULT_MAX_TOKENS
            this.latestUsagePercent = maxTokens > 0 ? Math.round((currentTokens / maxTokens) * 100) : 0
            log(`[AC] Path3 HIT: ${currentTokens} tokens, ${this.latestUsagePercent}% of ${maxTokens}`)
            this.emitStatus(this.latestSessionId, this.latestPhase, this.latestUsagePercent, this.latestCurrentTokens)
            this.successfulRefreshCount++
            return
          }
        }
      } catch (e) {
        log(`[AC] Path3 FAILED: ${String(e)}`)
      }
    } else {
      log('[AC] Path2+3 SKIP: sessionProjections is undefined')
    }

    log(`[AC] refreshAndEmit: ALL PATHS ZERO — emitting 0/${this.latestContextWindow ?? DEFAULT_MAX_TOKENS}`)
    this.emitStatus(
      this.latestSessionId,
      this.latestPhase,
      this.latestUsagePercent,
      this.latestCurrentTokens,
    )
  }

  /**
   * Emit a compression status event for the client UI and update the
   * latest snapshot for the `getStatus` Remote method.
   * @param sessionId - the session identity.
   * @param phase - the current lifecycle phase.
   * @param usagePercent - current usage percentage.
   * @param currentTokens - current token count.
   */
  private emitStatus(
    sessionId: string,
    phase: CompressPhase,
    usagePercent: number,
    currentTokens: number,
  ): void {
    this.latestPhase = phase
    // Only update token counters when we have a real measurement (> 0).
    // This prevents resetting to 0 on phase-only transitions.
    if (usagePercent > 0 || currentTokens > 0) {
      this.latestUsagePercent = usagePercent
      this.latestCurrentTokens = currentTokens
    }
    const payload = {
      sessionId,
      phase,
      usagePercent,
      currentTokens,
      maxTokens: this.latestContextWindow ?? DEFAULT_MAX_TOKENS,
    }
    log(`[AC] emitStatus → ctx.emit('automatic-compress/status'): ${JSON.stringify(payload)}`)
    this.selfCtx.emit('automatic-compress/status', payload)
  }
}

export default AutomaticCompress
