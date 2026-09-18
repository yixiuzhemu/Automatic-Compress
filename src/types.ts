/**
 * Wire vocabulary for the automatic compression plugin: the compression
 * status the host publishes and the client renders, plus the Cordis events
 * that announce compression lifecycle transitions.
 *
 * @module @automatic-compress/automatic-compress/types
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Pre-step waterfall: we hook this only to track the current session
     * for the UI. Automatic compression is handled by dsh's built-in engine.
     * @mode waterfall
     */
    'agent/pre-step'(payload: AgentPreStepPayload, next: () => Promise<unknown>): Promise<unknown>

    /**
     * A session event was committed. We listen to this to refresh token
     * counts, broadcast compaction notices, and auto-continue truncated turns.
     * @mode emit
     */
    'session/event'(session: unknown, event: unknown): void

    /**
     * The compression status changed for a session. The host emits this at
     * each lifecycle transition (idle → compressing → idle) so the client
     * UI can render a progress indicator without polling.
     * @mode emit
     */
    'automatic-compress/status'(payload: CompressStatusPayload): void

    /**
     * A compression cycle completed for a session. Carries the outcome
     * (success, skipped, or error) so the client can dismiss or persist
     * the status badge.
     * @mode emit
     */
    'automatic-compress/done'(payload: CompressDonePayload): void
  }
}

/**
 * The `agent/pre-step` waterfall payload shape. We only read `agent.id`
 * and `agent.session` for session tracking.
 */
export interface AgentPreStepPayload {
  /** The agent proposing the step. */
  readonly agent: {
    readonly id: string
    readonly session: unknown
    readonly status: string
  }
  /** Messages removed from the inbox for this step. */
  readonly messages: readonly unknown[]
  /** The turn that will own the step. */
  readonly turn: number
  /** The step proposed by the loop. */
  readonly step: number
  /** The current turn's cancellation signal. */
  readonly signal: AbortSignal
}

/**
 * Why the automatic policy triggered compression. Mirrors the compaction
 * seam's `CompactionTrigger` vocabulary.
 */
export type CompressTrigger = 'pressure' | 'context-overflow'

/**
 * The lifecycle phase of one compression cycle. The client renders each
 * phase as a distinct visual state.
 */
export type CompressPhase = 'idle' | 'compressing'

/**
 * One compression status broadcast. The host emits this at each phase
 * transition; the client renders the latest snapshot.
 */
export interface CompressStatusPayload {
  /** The session whose compression status changed (shared agent/session id). */
  readonly sessionId: string
  /** The current lifecycle phase. */
  readonly phase: CompressPhase
  /** Current context usage as a percentage (0–100). */
  readonly usagePercent: number
  /** Estimated current token count. */
  readonly currentTokens: number
  /** The real model context window, or fallback default. */
  readonly maxTokens: number
}

/**
 * The outcome of one completed compression cycle.
 */
export interface CompressDonePayload {
  /** The session that completed compression (shared agent/session id). */
  readonly sessionId: string
  /** Whether compression succeeded, was skipped, or errored. */
  readonly outcome: 'success' | 'skipped' | 'error'
  /** Human-readable detail; present on error outcomes. */
  readonly detail?: string
  /** Token count after compression, when known. */
  readonly tokensAfter?: number
}

/**
 * The resolved plugin configuration.
 */
export interface AutomaticCompressConfig {
  /**
   * Whether the plugin is enabled. When false, no monitoring occurs.
   * @default true
   */
  readonly enabled: boolean
  /**
   * Tool name for the model-callable compact tool.
   * @default 'compact_context'
   */
  readonly toolName?: string
  /**
   * Whether to register the agent tool. When false, only UI monitoring
   * and the manual Compact button are available.
   * @default true
   */
  readonly registerTool?: boolean
  /**
   * Whether to broadcast compaction progress notices in the conversation.
   * When true, `compaction/start|summary|end` events produce visible
   * foldable lines in the chat surface.
   * @default true
   */
  readonly notice?: boolean
  /**
   * Maximum number of automatic continues when a turn is truncated by
   * the output token limit. 0 disables auto-continue.
   * @default 2
   */
  readonly maxAutoContinues?: number
}
