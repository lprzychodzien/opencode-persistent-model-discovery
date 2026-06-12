#!/usr/bin/env node
/**
 * Model Sync Script
 *
 * Fetches available models from an OpenAI-compatible provider's API and
 * saves them to the plugin cache directory (NOT the config file).
 *
 * Usage: node sync-models.mjs <provider>
 * Example: node sync-models.mjs surplus
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function getConfigDir() {
  const xdgConfig = process.env.XDG_CONFIG_HOME
  if (xdgConfig) return path.join(xdgConfig, 'opencode')
  return path.join(os.homedir(), '.config', 'opencode')
}

function getDataDir() {
  const xdgData = process.env.XDG_DATA_HOME
  if (xdgData) return path.join(xdgData, 'opencode')
  return path.join(os.homedir(), '.local', 'share', 'opencode')
}

function getCacheDir() {
  const xdgCache = process.env.XDG_CACHE_HOME
  if (xdgCache) return path.join(xdgCache, 'opencode')
  return path.join(os.homedir(), '.cache', 'opencode')
}

const CONFIG_FILE = path.join(getConfigDir(), 'opencode.json')
const AUTH_FILE = path.join(getDataDir(), 'auth.json')

async function loadJSON(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

async function saveJSON(filePath, data) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function getApiKey(provider, config, authData) {
  const auth = authData?.[provider]
  if (auth?.type === 'api' && auth.key) {
    return auth.key
  }
  return config?.provider?.[provider]?.options?.apiKey
}

async function discoverModels(baseURL, apiKey) {
  const url = baseURL.endsWith('/') ? `${baseURL}models` : `${baseURL}/models`
  console.log(`   URL: ${url}`)

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

    const data = await response.json()
    return data.data || []
  } catch (error) {
    clearTimeout(timeoutId)
    if (error.name === 'AbortError') {
      throw new Error('Request timed out after 10 seconds')
    }
    throw error
  }
}

async function main() {
  const provider = process.argv[2]
  if (!provider) {
    console.error('Usage: node sync-models.mjs <provider>')
    console.error('Example: node sync-models.mjs surplus')
    process.exit(1)
  }

  const cacheFile = path.join(getCacheDir(), `models-${provider}.json`)

  console.log(`🔍 Model Sync: ${provider}`)
  console.log('=====================\n')

  const config = await loadJSON(CONFIG_FILE)
  if (!config) {
    console.error(`❌ Config file not found: ${CONFIG_FILE}`)
    process.exit(1)
  }

  const providerConfig = config.provider?.[provider]
  if (!providerConfig) {
    console.error(`❌ Provider "${provider}" not found in config`)
    process.exit(1)
  }

  const baseURL = providerConfig.options?.baseURL
  if (!baseURL) {
    console.error(`❌ baseURL not configured for provider "${provider}"`)
    process.exit(1)
  }

  const authData = await loadJSON(AUTH_FILE)
  const apiKey = getApiKey(provider, config, authData)

  if (!apiKey) {
    console.error(`❌ No API key found. Please authenticate with: opencode auth add ${provider}`)
    process.exit(1)
  }

  console.log(`📡 Fetching models from ${baseURL}...`)

  try {
    const models = await discoverModels(baseURL, apiKey)
    console.log(`✅ Found ${models.length} models`)

    const cacheData = {}
    for (const model of models) {
      cacheData[model.id] = {
        id: model.id,
        name: model.name || model.id,
      }
    }

    await saveJSON(cacheFile, cacheData)

    console.log(`\n💾 Saved ${models.length} models to cache`)
    console.log(`📁 Cache file: ${cacheFile}`)
    console.log('\n📝 Note: Models are now cached and will be loaded at startup')
    console.log('   No changes were made to your opencode.json config file')
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`)
    process.exit(1)
  }
}

main()
