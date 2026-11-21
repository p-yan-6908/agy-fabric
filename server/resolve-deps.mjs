// Portable dependency resolver for agy-fabric.
// Looks in this plugin's own node_modules first, then falls back to ~/.gemini/config/plugins/fabric,
// ~/.pi/agent/npm/node_modules, and any extra local checkout roots.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOME = homedir()
const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = dirname(SERVER_DIR)

const firstExisting = candidates => {
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

const packageRoots = (pkg, extraRoots = []) => [
  join(PLUGIN_ROOT, 'node_modules', pkg),
  join(HOME, '.gemini', 'config', 'plugins', 'fabric', 'node_modules', pkg),
  join(HOME, '.pi', 'agent', 'npm', 'node_modules', pkg),
  ...extraRoots,
]

export const resolvePackageFile = (pkg, relPath, extraRoots = []) =>
  firstExisting(packageRoots(pkg, extraRoots).map(root => join(root, relPath)))

export const resolvePackageDir = (pkg, extraRoots = []) => firstExisting(packageRoots(pkg, extraRoots))

export const importFile = async filePath => {
  if (!filePath || !existsSync(filePath)) return null
  return import(pathToFileURL(filePath).href)
}
