import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function getDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME
  if (xdgData) return path.join(xdgData, 'opencode')
  return path.join(os.homedir(), '.local', 'share', 'opencode')
}

function getCacheDir(): string {
  const xdgCache = process.env.XDG_CACHE_HOME
  if (xdgCache) return path.join(xdgCache, 'opencode')
  return path.join(os.homedir(), '.cache', 'opencode')
}

async function discoverModels(baseURL: string, apiKey: string): Promise<Array<{ id: string; name?: string }>> {
  const url = baseURL.endsWith('/') ? `${baseURL}models` : `${baseURL}/models`
  
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })
    
    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`Discovery failed: ${response.status} ${response.statusText}`)
    }

    const data = await response.json() as { data?: Array<{ id: string; name?: string }> }
    return data.data || []
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

async function loadCache(providerName: string): Promise<Record<string, any> | null> {
  const cacheFile = path.join(getCacheDir(), `models-${providerName}.json`)
  try {
    const content = await fs.readFile(cacheFile, 'utf8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

async function saveCache(providerName: string, models: Record<string, any>): Promise<void> {
  const cacheDir = getCacheDir()
  await fs.mkdir(cacheDir, { recursive: true })
  const cacheFile = path.join(cacheDir, `models-${providerName}.json`)
  await fs.writeFile(cacheFile, JSON.stringify(models, null, 2), 'utf8')
}

async function getAuthKey(providerName: string): Promise<string | undefined> {
  const authPath = path.join(getDataDir(), 'auth.json')
  try {
    const content = await fs.readFile(authPath, 'utf8')
    const auths = JSON.parse(content) as Record<string, { type?: string; key?: string }>
    const auth = auths[providerName]
    if (auth?.type === 'api' && auth.key) {
      return auth.key
    }
  } catch {
    // ignore
  }
  return undefined
}

export const PersistentModelDiscoveryPlugin: Plugin = async (input: PluginInput) => {
  const { client } = input
  const logger = client?.app?.log ? client.app.log.bind(client.app) : console.log

  return {
    config: async (config: any) => {
      const providers = config.provider || {}

      for (const [providerName, providerConfig] of Object.entries(providers)) {
        const p = providerConfig as any

        const discoveryConfig = p.options?.modelsDiscovery
        if (!discoveryConfig?.enabled) {
          continue
        }

        const baseURL = p.options?.baseURL
        if (!baseURL) {
          continue
        }

        const apiKey = p.options?.apiKey || await getAuthKey(providerName)
        if (!apiKey) {
          logger?.({ service: 'persistent-model-discovery', level: 'warn', message: `No API key for ${providerName}` })
          continue
        }

        // Step 1: Load cached models synchronously
        const cachedModels = await loadCache(providerName)
        if (cachedModels && Object.keys(cachedModels).length > 0) {
          const existingModels = p.models || {}
          p.models = {
            ...cachedModels,
            ...existingModels,  // Config file entries take precedence
          }
          logger?.({
            service: 'persistent-model-discovery',
            level: 'info',
            message: `Loaded ${Object.keys(cachedModels).length} cached models for ${providerName}`,
          })
        }

        // Step 2: Async background discovery to update cache
        try {
          const models = await discoverModels(baseURL, apiKey)
          const discoveredModels: Record<string, any> = {}
          
          for (const model of models) {
            discoveredModels[model.id] = {
              id: model.id,
              name: model.name || model.id,
            }
          }

          // Save to cache for next startup
          await saveCache(providerName, discoveredModels)
          
          // Merge into current session (without persisting to config file)
          const existingModels = p.models || {}
          p.models = {
            ...existingModels,
            ...discoveredModels,
          }

          logger?.({
            service: 'persistent-model-discovery',
            level: 'info',
            message: `Discovered ${Object.keys(discoveredModels).length} models for ${providerName}`,
          })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          logger?.({
            service: 'persistent-model-discovery',
            level: 'error',
            message: `Failed to discover models for ${providerName}: ${errorMessage}`,
          })
        }
      }
    },
  }
}

export default PersistentModelDiscoveryPlugin