import { readFile, writeFile, mkdir, access, copyFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parse, modify, applyEdits } from "jsonc-parser"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
await access(join(root, "dist", "gui-experimental.cjs")).catch(() => { throw new Error("Run npm run build first.") })
const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
await mkdir(configDir, { recursive: true })
const exists = async path => access(path).then(() => true, () => false)
const path = await exists(join(configDir, "opencode.jsonc")) ? join(configDir, "opencode.jsonc") : join(configDir, "opencode.json")
const original = await exists(path) ? await readFile(path, "utf8") : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
const errors = []
const config = parse(original, errors, { allowTrailingComma: true })
if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error("Existing OpenCode config is invalid; nothing was changed.")
if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error("Expected plugins to be an array; nothing was changed.")
const target = pathToFileURL(root).href
const plugins = config.plugins ?? []
if (plugins.some(entry => (typeof entry === "string" ? entry : entry?.package) === target)) {
  console.log(`Already installed from ${root}`)
} else {
  const updated = applyEdits(original, modify(original, ["plugins"], [...plugins, target], {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes("\r\n") ? "\r\n" : "\n" },
  }))
  if (await exists(path)) await copyFile(path, `${path}.account-usage-${Date.now()}.bak`)
  await writeFile(path, updated, "utf8")
  console.log(`Installed account-usage in ${path}`)
}
console.log("Open Settings → Account usage, or run /account-usage. Config reloads automatically.")
