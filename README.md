# Automatic-Compress

A [deepseek-harness](https://github.com/deepseek-harness/deepseek-harness) cordis plugin that observes context usage, surfaces a companion chip beside dsh's own `ContextMeter` ring, and adds manual compaction, auto-continue on truncation, and in-chat compaction notices.

## Features

- **Automatic Context Compression**: Delegates to dsh's built-in `BasicCompactionEngine` (default trigger at 80% of the routed model's context window). This plugin observes and reports — it does not re-implement the compression policy.
- **Companion Chip UI**: A minimal chip rendered in `conversation.input.right`, beside dsh's `ContextMeter` ring. It deliberately does **not** re-draw context occupancy (the ring already shows that from the same `contextPressure` projection). Instead it carries only what the ring lacks:
  - Proximity to the auto-compress trigger (state-colored dot + short label)
  - Manual **Compact** / **New Chat** actions in a click-open popover
  - Compression lifecycle feedback (compressing / compressed / error)
- **Agent-Callable Tool**: Registers a `compact_context` tool the model can invoke to compress other sessions.
- **Auto-Continue on Truncation**: When a turn is cut short by the output token limit, automatically sends a follow-up "继续" (configurable, up to N times).
- **In-Chat Notices**: Broadcasts `compaction/start|summary|end` events as foldable status lines in the conversation surface.
- **Localization**: Built-in English and Simplified Chinese translations.

## How It Works

1. The host service hooks into `agent/pre-step` (session tracking) and `session/event` (token refresh, compaction notices, auto-continue).
2. At each event, it measures current token usage via `ctx.tokenMeter` (primary) or falls back to `ctx.sessionProjections.stateOf('contextPressure')` / `.snapshot()`.
3. **Automatic compression is handled by dsh's `BasicCompactionEngine`**, not this plugin. The engine fires at `floor(contextWindow × thresholdRatio)` (default `thresholdRatio = 0.8`).
4. The client reads live occupancy from the `contextPressure` session projection via `useProjection` — the same push-fed source dsh's own `ContextMeter` renders. The controller only supplies the initial seed and manual-compaction outcomes (host→browser event forwarding has a fixed allowlist that does not include plugin-emitted events).
5. The companion chip renders trigger proximity, actions, and lifecycle status beside the ring.

## Configuration

The plugin accepts the following configuration options:

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether the plugin is enabled. When `false`, no monitoring occurs. |
| `toolName` | string | `'compact_context'` | Name of the agent-callable compact tool. |
| `registerTool` | boolean | `true` | Whether to register the agent tool. When `false`, only UI monitoring and the manual Compact button are available. |
| `notice` | boolean | `true` | Whether to broadcast compaction progress notices as foldable lines in the conversation. |
| `maxAutoContinues` | number | `2` | Maximum automatic continues when a turn is truncated by the output token limit. `0` disables auto-continue. |

> **Note**: The auto-compression trigger threshold (80% by default) is configured on dsh's `BasicCompactionEngine`, not on this plugin. See dsh's `thresholdRatio` and `modelPolicies` for per-model tuning.

Example `cordis.patch.yml`:

```yaml
- insert:
    - id: automatic-compress
      name: '@automatic-compress/automatic-compress'
      config:
        enabled: true
        toolName: compact_context
        registerTool: true
        notice: true
        maxAutoContinues: 2
```

## Project Structure

```
├── src/
│   ├── index.ts              # Host-side Cordis service (AutomaticCompress)
│   ├── tool.ts               # Agent-callable compact_context tool definition
│   ├── types.ts              # Shared type definitions (events, config, payloads)
│   └── client/
│       ├── index.ts          # Client-side plugin entry (apply)
│       ├── controller.ts     # Status controller (snapshot store, manual compact)
│       ├── compress-remote.ts # Remote namespace contribution (wire descriptors)
│       ├── CompressStatus.tsx # React companion chip component
│       ├── CompressStatus.module.css # Chip + popover styles
│       ├── locales.ts        # i18n strings (en, zh)
│       ├── types.ts          # Client-side type definitions
│       └── css-modules.d.ts  # CSS module type declarations
├── scripts/
│   ├── clean.mjs             # Build artifact cleanup
│   └── normalize-client-banner.mjs # Client bundle normalization
├── cordis.patch.yml          # dsh bundle patch
├── package.json
├── tsconfig.json             # Host TypeScript config
├── tsconfig.client.json      # Client TypeScript config
├── tsconfig.base.json        # Shared TypeScript config
└── tsdown.config.ts          # Client bundle config
```

## Building

```bash
# Install dependencies
pnpm install

# Build the plugin (host + client)
pnpm build

# Type-check
pnpm typecheck

# Watch mode for client development
pnpm watch
```

## Development

This plugin follows the same coding style and architecture patterns as the [Assistant-Manager](https://github.com/yixiuzhemu/Assistant-Manager) plugin:

- **Host side**: A Cordis `Service` subclass registered as `ctx.automaticCompress`, using `ctx.effect()` for teardown and `ctx.on()` for event listeners.
- **Client side**: A self-contained `apply()` function that registers locale dictionaries, mounts the `compress` Remote namespace, creates a controller, and injects the companion chip into `conversation.input.right`.
- **Build pipeline**: `tsdown` for the client bundle with CSS Modules inlined via `lightningcss`, matching the dsh client preset.

## License

MIT
