// Shared discovery + cache logic, used by the plugin (src/index.ts) and by
// sync-models.mjs. Plain JS so Node can import it without a TypeScript step.

import { promises as fs, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function getDataDir() {
  const xdgData = process.env.XDG_DATA_HOME
  if (xdgData) return path.join(xdgData, 'opencode')
  return path.join(os.homedir(), '.local', 'share', 'opencode')
}

export function getCacheDir() {
  const xdgCache = process.env.XDG_CACHE_HOME
  if (xdgCache) return path.join(xdgCache, 'opencode')
  return path.join(os.homedir(), '.cache', 'opencode')
}

export function cacheFile(providerID) {
  return path.join(getCacheDir(), `models-${providerID}.json`)
}

const LOG_FILE = () => path.join(getCacheDir(), 'persistent-model-discovery.log')

/** Append one line to ~/.cache/opencode/persistent-model-discovery.log (never throws). */
export function log(level, message) {
  try {
    mkdirSync(getCacheDir(), { recursive: true })
    appendFileSync(LOG_FILE(), `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`)
  } catch {
    // logging must never break opencode
  }
}

const KNOWN_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'pdf'])

function perMillion(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined
}

/**
 * Normalize one entry from an OpenAI/OpenRouter-style `/models` response into
 * the compact form stored in the cache file. Old caches ({id, name}) remain valid.
 */
export function normalizeModel(raw) {
  const arch = raw.architecture || {}
  const top = raw.top_provider || {}
  const features = [...(raw.supported_features || []), ...(raw.supported_parameters || [])]
  const entry = { id: raw.id, name: raw.name || raw.id }

  const context = Number(raw.context_length || top.context_length)
  if (Number.isInteger(context) && context > 0) entry.context = context
  const output = Number(top.max_completion_tokens)
  if (Number.isInteger(output) && output > 0) entry.output = output

  if (raw.supported_features || raw.supported_parameters) entry.tools = features.includes('tools')
  if (Array.isArray(arch.input_modalities)) {
    entry.input = arch.input_modalities.map((m) => (m === 'file' ? 'pdf' : m)).filter((m) => KNOWN_MODALITIES.has(m))
  }
  if (Array.isArray(arch.output_modalities)) entry.outputModalities = arch.output_modalities

  const p = raw.pricing || {}
  const input = perMillion(p.prompt)
  const out = perMillion(p.completion)
  if (input !== undefined && out !== undefined) {
    entry.cost = {
      input,
      output: out,
      cacheRead: perMillion(p.input_cache_read) ?? 0,
      cacheWrite: perMillion(p.input_cache_write) ?? 0,
    }
  }
  return entry
}

/** True for models that produce text (used by the `textOnly` option to skip image/video/music/TTS/embedding models). */
export function isChatModel(entry) {
  return !Array.isArray(entry.outputModalities) || entry.outputModalities.includes('text')
}

export async function fetchModels(baseURL, apiKey, timeoutMs = 15000) {
  const url = baseURL.endsWith('/') ? `${baseURL}models` : `${baseURL}/models`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
        // Some providers (e.g. Surplus) mislabel uncompressed bodies as brotli, breaking decoding
        'Accept-Encoding': 'identity',
      },
    })
    if (!response.ok) throw new Error(`Discovery failed: ${response.status} ${response.statusText} (${url})`)
    const data = await response.json()
    const list = Array.isArray(data) ? data : data.data || []
    const models = {}
    for (const raw of list) {
      if (raw && typeof raw.id === 'string') models[raw.id] = normalizeModel(raw)
    }
    return models
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs / 1000}s (${url})`)
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

/** Synchronous so it can run inside opencode's (synchronous) model transform. */
export function loadCacheSync(providerID) {
  try {
    const data = JSON.parse(readFileSync(cacheFile(providerID), 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

export async function saveCache(providerID, models) {
  await fs.mkdir(getCacheDir(), { recursive: true })
  const file = cacheFile(providerID)
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(models, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, file)
}

/** API key from opencode's auth store (v1 `{type:"api", key}` entries). */
export function getAuthKeySync(providerID) {
  for (const name of ['auth.json']) {
    try {
      const auths = JSON.parse(readFileSync(path.join(getDataDir(), name), 'utf8'))
      const auth = auths?.[providerID]
      if (auth?.type === 'api' && auth.key) return auth.key
    } catch {
      // ignore
    }
  }
  return undefined
}
