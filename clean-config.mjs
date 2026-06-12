#!/usr/bin/env node
/**
 * Clean Provider Config
 *
 * Removes all hardcoded models from a provider in your opencode.json config
 * file and sets it up to use cache-based discovery.
 *
 * Usage: node clean-config.mjs <provider>
 * Example: node clean-config.mjs surplus
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function getConfigDir() {
  const xdgConfig = process.env.XDG_CONFIG_HOME
  if (xdgConfig) return path.join(xdgConfig, 'opencode')
  return path.join(os.homedir(), '.config', 'opencode')
}

const CONFIG_FILE = path.join(getConfigDir(), 'opencode.json')

async function main() {
  const provider = process.argv[2]
  if (!provider) {
    console.error('Usage: node clean-config.mjs <provider>')
    console.error('Example: node clean-config.mjs surplus')
    process.exit(1)
  }

  console.log(`🧹 Cleaning Config: ${provider}`)
  console.log('=========================\n')

  const content = await fs.readFile(CONFIG_FILE, 'utf8')
  const config = JSON.parse(content)

  const providerConfig = config.provider?.[provider]
  if (!providerConfig) {
    console.error(`❌ Provider "${provider}" not found in config`)
    process.exit(1)
  }

  const beforeCount = Object.keys(providerConfig.models || {}).length
  console.log(`📊 Current models in config: ${beforeCount}`)

  // Clear models section
  providerConfig.models = {}

  // Ensure modelsDiscovery is enabled
  if (!providerConfig.options) {
    providerConfig.options = {}
  }
  providerConfig.options.modelsDiscovery = {
    enabled: true,
  }

  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8')

  console.log('✅ Removed all hardcoded models from config')
  console.log('✅ Enabled modelsDiscovery for cache-based loading')
  console.log(`📁 Config file: ${CONFIG_FILE}`)
  console.log('\n📝 Note: Models will now be loaded from cache at startup')
  console.log('   Run the sync script to populate cache:')
  console.log(`   node sync-models.mjs ${provider}`)
}

main().catch((err) => {
  console.error(`❌ Error: ${err.message}`)
  process.exit(1)
})
