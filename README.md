# OpenCode Persistent Model Discovery

An [OpenCode](https://opencode.ai) plugin that discovers and persistently caches AI models from OpenAI-compatible providers. Solves the race condition where OpenCode's provider resolution runs before async model discovery completes.

## The Problem

OpenCode has a built-in `opencode-models-discovery` plugin that fetches models from provider APIs. However, it runs asynchronously during the config hook. OpenCode's provider resolution (which validates that requested models exist) runs **before** the async discovery finishes. This causes:

```
ProviderModelNotFoundError: Model not found: surplus/claude-opus-4.8
```

Even though the model exists and the API is accessible.

## The Solution

This plugin implements a **two-phase discovery strategy**:

1. **Phase 1 - Synchronous Cache Load**: At startup, immediately loads previously discovered models from a local cache file (`~/.cache/opencode/models-{provider}.json`). These are merged into the provider's model map before OpenCode resolves providers.

2. **Phase 2 - Async Background Refresh**: After startup, asynchronously fetches the latest models from the provider's API and updates the cache for the next session.

This means models are always available immediately, while staying up-to-date in the background.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   opencode.json │     │   Cache File     │     │   Provider API  │
│   (Config)      │     │   (~/.cache/...)│     │   (/v1/models) │
└────────┬────────┘     └────────┬─────────┘     └────────┬────────┘
         │                       │                        │
         │  Provider settings    │  Discovered models     │  Fresh models
         │  (baseURL, etc)       │  (from last sync)      │  (current)
         │                       │                        │
         └───────────┬───────────┴────────────┬───────────┘
                     │                          │
                     ▼                          │
         ┌─────────────────────┐                 │
         │  Persistent Model   │◄────────────────┘
         │  Discovery Plugin   │  Async refresh
         │                     │  (after startup)
         └─────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
         ▼                       ▼
┌─────────────────┐    ┌──────────────────┐
│  Phase 1: Load  │    │  Phase 2: Fetch  │
│  cache sync     │    │  API async       │
│                 │    │                  │
│  Before provider│    │  After startup   │
│  resolution     │    │  Update cache    │
└─────────────────┘    └──────────────────┘
```

## Installation

### Method 1: Local Directory (Recommended for Development)

1. Clone or download this repository
2. Add to your `opencode.json` config file:

```json
{
  "plugin": [
    "/path/to/opencode-persistent-model-discovery"
  ],
  "provider": {
    "surplus": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Surplus Intelligence",
      "options": {
        "baseURL": "https://www.surplusintelligence.ai/api/inference/v1",
        "modelsDiscovery": {
          "enabled": true
        }
      }
    },
    "openrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "modelsDiscovery": {
          "enabled": true
        }
      }
    }
  }
}
```

### Method 2: From npm (When Published)

```bash
npm install opencode-persistent-model-discovery
```

Then in `opencode.json`:
```json
{
  "plugin": [
    "opencode-persistent-model-discovery"
  ]
}
```

### Method 3: GitHub Direct

```json
{
  "plugin": [
    "github:lprzychodzien/opencode-persistent-model-discovery"
  ]
}
```

## Quick Start

### Step 1: Configure Your Provider

Ensure your provider has `modelsDiscovery.enabled: true`:

```json
{
  "provider": {
    "surplus": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Surplus Intelligence",
      "options": {
        "baseURL": "https://www.surplusintelligence.ai/api/inference/v1",
        "modelsDiscovery": {
          "enabled": true
        }
      }
    }
  }
}
```

**Configuration Options:**
- `baseURL` (required): The provider's API base URL. Must include `/v1` for OpenAI-compatible providers. The plugin requests models from `{baseURL}/models`.
- `modelsDiscovery.enabled` (required): Must be `true` for this plugin to process the provider.
- `apiKey` (optional): Explicit API key. If omitted, plugin reads from OpenCode's auth store.

### Step 2: Set Up Authentication

Store your API key in OpenCode's auth store (recommended):

```bash
opencode auth add surplus
opencode auth add openrouter
# Enter your API key when prompted
```

Or set it in your config (less secure):
```json
{
  "provider": {
    "surplus": {
      "options": {
        "apiKey": "your-api-key-here"
      }
    },
    "openrouter": {
      "options": {
        "apiKey": "your-api-key-here"
      }
    }
  }
}
```

### Step 3: Initial Cache Population

Run the sync script to discover and cache models (once per provider):

```bash
cd /path/to/opencode-persistent-model-discovery
node sync-models.mjs surplus
node sync-models.mjs openrouter
```

Expected output:
```
🔍 Model Sync: surplus
=====================
📡 Fetching models from https://www.surplusintelligence.ai/api/inference/v1...
   URL: https://www.surplusintelligence.ai/api/inference/v1/models
✅ Found 242 models
💾 Saved 242 models to cache
📁 Cache file: ~/.cache/opencode/models-surplus.json
📝 Note: Models are now cached and will be loaded at startup
```

### Step 4: Start OpenCode

```bash
opencode
```

Models are loaded from cache at startup. The plugin will also refresh the cache in the background.

## File Reference

### Plugin File: `src/index.ts`

The main plugin that hooks into OpenCode's config phase.

**Key Behaviors:**
- Loads cached models synchronously before provider resolution
- Runs async discovery after startup to refresh cache
- Handles timeouts (10s for API calls)
- Reads API keys from auth store or config
- Supports multiple providers simultaneously

**Cache Location:** `~/.cache/opencode/models-{providerName}.json`

### Sync Script: `sync-models.mjs`

Standalone script to manually refresh the model cache for a provider.

**Use Cases:**
- First-time setup
- After provider adds new models
- When you see "Model not found" errors (cache is stale)
- CI/CD pipelines to pre-populate cache

**Command:**
```bash
node sync-models.mjs <provider>
# e.g. node sync-models.mjs surplus
```

**What it does:**
1. Reads `opencode.json` to find the provider's config
2. Reads `~/.local/share/opencode/auth.json` for the API key
3. Fetches `{baseURL}/models` from the provider API
4. Saves results to `~/.cache/opencode/models-{provider}.json`
5. Does NOT modify `opencode.json`

### Clean Script: `clean-config.mjs`

Removes hardcoded models from a provider in your config and enables discovery mode.

**Use Case:** When migrating from manual model lists to cached discovery.

**Command:**
```bash
node clean-config.mjs <provider>
# e.g. node clean-config.mjs surplus
```

**What it does:**
1. Reads `opencode.json`
2. Empties `provider.{provider}.models` section
3. Sets `modelsDiscovery.enabled: true`
4. Saves config

## Cache Management

### Where is the Cache?

The plugin uses `XDG_CACHE_HOME` if set, otherwise it falls back to `~/.cache/opencode/` on all platforms:

```
$XDG_CACHE_HOME/opencode/models-{provider}.json   # if XDG_CACHE_HOME is set
~/.cache/opencode/models-{provider}.json           # default (macOS, Linux, Windows)
```

### Cache Format

```json
{
  "claude-opus-4.8": {
    "id": "claude-opus-4.8",
    "name": "Claude Opus 4.8"
  },
  "gpt-5.5": {
    "id": "gpt-5.5",
    "name": "GPT 5.5"
  }
}
```

Each entry has:
- `id`: Model identifier (used in API requests)
- `name`: Human-readable display name

### Updating the Cache

**Manual update:**
```bash
node sync-models.mjs surplus
```

**Automated update (cron):**
```bash
# Run daily at 9 AM
0 9 * * * cd /path/to/plugin && node sync-models.mjs surplus
```

**Shell alias:**
```bash
# Add to .bashrc or .zshrc
alias sync-models='node /path/to/opencode-persistent-model-discovery/sync-models.mjs surplus'
```

### Clearing the Cache

```bash
rm ~/.cache/opencode/models-*.json
```

Next startup will run without cached models (Phase 2 will repopulate).

## Supported Providers

Any provider implementing the OpenAI `/v1/models` endpoint:

| Provider | Base URL | Status |
|----------|----------|--------|
| [Surplus Intelligence](https://surplusintelligence.ai) | `https://www.surplusintelligence.ai/api/inference/v1` | ✅ Tested |
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api/v1` | ✅ Compatible |
| [Ollama](https://ollama.com) | `http://localhost:11434/v1` | ✅ Compatible |
| [LiteLLM](https://litellm.ai) | Custom | ✅ Compatible |
| Custom proxies | Custom | ✅ Compatible |

## Troubleshooting

### "Model not found" Error

**Cause:** Cache is stale or missing.
**Fix:**
```bash
node sync-models.mjs surplus
```

### "No API key found"

**Cause:** Auth not configured.
**Fix:**
```bash
opencode auth add surplus
# Or add to config: "apiKey": "your-key"
```

### "Discovery failed: 404"

**Cause:** Incorrect baseURL or endpoint.
**Fix:** Verify `baseURL` includes `/v1`:
```json
"baseURL": "https://api.example.com/api/inference/v1"
```

### "Config object is frozen"

**Cause:** Plugin loaded too late in OpenCode lifecycle.
**Fix:** Ensure plugin is listed first in `opencode.json` plugins array.

### Provider not being processed

**Checklist:**
1. Provider has `modelsDiscovery.enabled: true`
2. Provider has `baseURL` configured
3. API key is accessible (auth store or config)
4. Plugin is listed in `opencode.json` plugins array
5. Plugin path is correct

## API Key Resolution

The plugin resolves API keys in this priority order:

1. `provider.options.apiKey` in `opencode.json`
2. OpenCode auth store: `~/.local/share/opencode/auth.json` (entries of `type: "api"`)

**Recommendation:** Use the auth store for security. Never commit API keys to version control.

## Multiple Providers

The plugin supports multiple providers simultaneously. Each provider gets its own cache file:

```json
{
  "provider": {
    "surplus": {
      "options": {
        "baseURL": "https://www.surplusintelligence.ai/api/inference/v1",
        "modelsDiscovery": { "enabled": true }
      }
    },
    "openrouter": {
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "modelsDiscovery": { "enabled": true }
      }
    }
  }
}
```

This creates:
- `~/.cache/opencode/models-surplus.json`
- `~/.cache/opencode/models-openrouter.json`

Run `node sync-models.mjs <provider>` for each provider you configure.

## Comparison: Built-in vs This Plugin

| Feature | Built-in Discovery | Persistent Discovery |
|---------|-------------------|----------------------|
| Timing | Async (after resolution) | Sync cache + async refresh |
| Persistence | In-memory only | Cache file on disk |
| Startup models | Available after delay | Available immediately |
| Config pollution | None | None (cache is separate) |
| Error handling | Silent failures | Logs to console |
| Multi-provider | Yes | Yes |
| Manual refresh | Not available | `sync-*.mjs` script |

## Development

### Project Structure

```
opencode-persistent-model-discovery/
├── src/
│   └── index.ts              # Main plugin code
├── package.json              # Package manifest
├── sync-models.mjs           # Manual sync script
├── clean-config.mjs          # Config cleanup script
└── README.md                 # This file
```

### Testing

```bash
# 1. Clean config
node clean-config.mjs surplus

# 2. Sync models
node sync-models.mjs surplus

# 3. Verify cache
ls -la ~/.cache/opencode/models-surplus.json

# 4. Test with opencode
opencode run "test" -m surplus/claude-opus-4.8
```

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Test with `sync-models.mjs <provider>`
5. Submit a pull request

## Requirements

- **OpenCode:** >= 1.2.0
- **Node.js:** >= 18.0.0
- **Provider:** OpenAI-compatible with `/v1/models` endpoint

## License

MIT License - see LICENSE file for details.

## Related Projects

- [opencode](https://opencode.ai) - The AI editor that this plugin extends
- [opencode-models-discovery](https://github.com/yuhp/opencode-models-discovery) - The built-in discovery plugin that inspired this approach

## Support

- **Issues:** [GitHub Issues](https://github.com/lprzychodzien/opencode-persistent-model-discovery/issues)
- **Discussions:** [GitHub Discussions](https://github.com/lprzychodzien/opencode-persistent-model-discovery/discussions)

---

**Note for AI Agents:** This plugin solves a specific race condition in OpenCode's plugin architecture. The key implementation detail is the two-phase approach: synchronous cache loading (Phase 1) before provider resolution, followed by asynchronous API refresh (Phase 2) after startup. The cache file format is a simple JSON map of model IDs to `{id, name}` objects.