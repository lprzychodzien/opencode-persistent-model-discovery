// OpenCode Persistent Model Discovery
//
// OpenCode 2.x: the default export is a `{ id, setup }` plugin definition. In
// setup we register a model transform that, for every provider whose settings
// contain `modelsDiscovery: { enabled: true }`, adds the models from the
// on-disk cache, then refreshes that cache from `{baseURL}/models` in the
// background and asks OpenCode to reload models when the list changes.
//
// OpenCode 1.x (>= 1.18.29) loads the `server` export instead, which keeps the
// original `config` hook behaviour.

import {
  fetchModels,
  getAuthKeySync,
  isChatModel,
  loadCacheSync,
  log,
  saveCache,
} from './discovery.mjs'

const PLUGIN_ID = 'opencode-persistent-model-discovery'
const DEFAULT_REFRESH_HOURS = 6
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000

type CachedModel = {
  id: string
  name?: string
  context?: number
  output?: number
  tools?: boolean
  input?: string[]
  outputModalities?: string[]
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}
type CachedModels = Record<string, CachedModel>

type DiscoveryOptions = {
  enabled?: boolean
  /** How often the background refresh re-fetches `/models` (default 6). */
  refreshIntervalHours?: number
  /** Only add models that output text, skipping image/video/audio/embedding models (default false). */
  textOnly?: boolean
}

type ProviderState = {
  models: CachedModels
  /** Epoch ms when the next background fetch is due (0 = now). */
  nextAt: number
  intervalMs: number
  baseURL: string
  apiKey?: string
  inFlight?: Promise<void>
}

function signature(models: CachedModels): string {
  return JSON.stringify(Object.keys(models).sort().map((k) => [k, models[k]]))
}

/** Copy a cached entry onto an OpenCode 2.x Model.Info draft. */
function applyToDraft(m: any, entry: CachedModel) {
  m.name = entry.name || entry.id
  if (entry.context) m.limit.context = entry.context
  if (entry.output) m.limit.output = entry.output
  if (m.limit.output > m.limit.context) m.limit.output = m.limit.context
  if (typeof entry.tools === 'boolean') m.capabilities.tools = entry.tools
  if (entry.input?.length) m.capabilities.input = [...entry.input]
  if (entry.outputModalities?.length) m.capabilities.output = [...entry.outputModalities]
  if (entry.cost) {
    m.cost = [
      {
        input: entry.cost.input,
        output: entry.cost.output,
        cache: { read: entry.cost.cacheRead, write: entry.cost.cacheWrite },
      },
    ]
  }
}

async function setup(ctx: any) {
  const state = new Map<string, ProviderState>()
  const warned = new Set<string>()
  let disposed = false

  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return
    warned.add(key)
    log('warn', message)
  }

  const refresh = (providerID: string, st: ProviderState) => {
    if (st.inFlight || disposed) return
    st.inFlight = (async () => {
      try {
        const models = await fetchModels(st.baseURL, st.apiKey)
        if (Object.keys(models).length === 0) throw new Error('provider returned an empty model list')
        st.nextAt = Date.now() + st.intervalMs
        const changed = signature(models) !== signature(st.models)
        if (changed) await saveCache(providerID, models)
        st.models = models
        log('info', `${providerID}: fetched ${Object.keys(models).length} models${changed ? ' (changed, reloading)' : ''}`)
        if (changed && !disposed) await ctx.model.reload()
      } catch (error) {
        // Retry sooner than the normal interval after a failure.
        st.nextAt = Date.now() + RETRY_AFTER_FAILURE_MS
        log('error', `${providerID}: discovery failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        st.inFlight = undefined
      }
    })()
  }

  const registration = await ctx.model.transform((editor: any) => {
    for (const record of editor.provider.list()) {
      const provider = record.provider
      const settings = provider.settings ?? {}
      const discovery: DiscoveryOptions | undefined = settings.modelsDiscovery
      if (!discovery?.enabled) continue

      const providerID = String(provider.id)
      const baseURL = settings.baseURL
      if (!baseURL) {
        warnOnce(`${providerID}:baseURL`, `${providerID}: modelsDiscovery is enabled but no baseURL is set`)
        continue
      }
      const apiKey = settings.apiKey || getAuthKeySync(providerID)
      if (!apiKey) warnOnce(`${providerID}:apiKey`, `${providerID}: no apiKey in config or auth.json; fetching /models without auth`)

      let st = state.get(providerID)
      if (!st) {
        const cached = (loadCacheSync(providerID) ?? {}) as CachedModels
        st = { models: cached, nextAt: 0, intervalMs: 0, baseURL, apiKey }
        state.set(providerID, st)
        log('info', `${providerID}: loaded ${Object.keys(cached).length} cached models`)
      }
      st.baseURL = baseURL
      st.apiKey = apiKey
      st.intervalMs = Math.max(0.05, discovery.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS) * 3600_000

      let added = 0
      for (const entry of Object.values(st.models)) {
        if (!entry?.id) continue
        if (discovery.textOnly && !isChatModel(entry)) continue
        // Models defined in opencode.json(c) take precedence over discovered ones.
        if (editor.get(providerID, entry.id)) continue
        editor.update(providerID, entry.id, (m: any) => applyToDraft(m, entry))
        added++
      }
      if (added) log('debug', `${providerID}: added ${added} discovered models`)

      if (Date.now() >= st.nextAt) refresh(providerID, st)
    }
  })

  // The background service can run for days; re-check periodically.
  const timer = setInterval(() => {
    for (const [providerID, st] of state) if (Date.now() >= st.nextAt) refresh(providerID, st)
  }, RETRY_AFTER_FAILURE_MS)
  ;(timer as any).unref?.()

  return async () => {
    disposed = true
    clearInterval(timer)
    await registration.dispose()
  }
}

// ---------------------------------------------------------------------------
// OpenCode 1.x compatibility: mutate config.provider[*].models in the config hook.

export const PersistentModelDiscoveryPlugin = async (_input: any) => ({
  config: async (config: any) => {
    for (const [providerID, p] of Object.entries<any>(config.provider || {})) {
      const discovery: DiscoveryOptions | undefined = p.options?.modelsDiscovery
      if (!discovery?.enabled || !p.options?.baseURL) continue
      const apiKey = p.options?.apiKey || getAuthKeySync(providerID)

      let models = (loadCacheSync(providerID) ?? {}) as CachedModels
      try {
        const fresh = (await fetchModels(p.options.baseURL, apiKey)) as CachedModels
        await saveCache(providerID, fresh)
        models = fresh
      } catch (error) {
        log('error', `${providerID}: discovery failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      const discovered: Record<string, any> = {}
      for (const entry of Object.values(models)) {
        if (discovery.textOnly && !isChatModel(entry)) continue
        discovered[entry.id] = {
          id: entry.id,
          name: entry.name || entry.id,
          ...(entry.context ? { limit: { context: entry.context, output: entry.output ?? Math.min(32000, entry.context) } } : {}),
          ...(typeof entry.tools === 'boolean' ? { tool_call: entry.tools } : {}),
        }
      }
      p.models = { ...discovered, ...(p.models || {}) }
    }
  },
})

export default Object.freeze({
  id: PLUGIN_ID,
  setup,
  server: PersistentModelDiscoveryPlugin,
})
