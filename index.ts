// OpenCode 2.x loads a local plugin directory through its root index file
// (package.json "main" is not consulted), so re-export the real entry here.
export { default, PersistentModelDiscoveryPlugin } from './src/index.ts'
