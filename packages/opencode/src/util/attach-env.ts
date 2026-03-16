import { gunzipSync, gzipSync } from "zlib"

const MAX_HEADER = 4 * 1024
const FORMAT_GZIP = "gz:"
const FORMAT_JSON = "json:"
const FALLBACK_KEYS = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "PYTHONPATH",
  "PYTHONHOME",
  "COMSPEC",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "MSBuildToolsPath_170",
])

const FALLBACK_PREFIXES = ["MSBuild", "VSCMD_", "VS", "VC", "WindowsSdk", "WindowsSDK", "Framework"]

const normalize = (input: unknown) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const env = Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      if (typeof value !== "string") return []
      return [[key, value]]
    }),
  )
  if (Object.keys(env).length === 0) return
  return env
}

export const ATTACH_ENV_HEADER = "x-opencode-env"

function serialize(env: Record<string, string>) {
  const json = Buffer.from(JSON.stringify(env), "utf8")
  const compressed = FORMAT_GZIP + gzipSync(json).toString("base64")
  if (compressed.length <= MAX_HEADER) return compressed

  const plain = FORMAT_JSON + json.toString("base64")
  if (plain.length <= MAX_HEADER) return plain
}

function fallback(env: Record<string, string>) {
  const sorted = Object.entries(env)
    .filter(
      ([key]) =>
        key.startsWith("OPENCODE_") ||
        key.startsWith("_") ||
        FALLBACK_KEYS.has(key) ||
        FALLBACK_PREFIXES.some((prefix) => key.startsWith(prefix)),
    )
    .sort(([a], [b]) => {
      const rank = (key: string) => {
        if (key.startsWith("OPENCODE_")) return 0
        if (key.startsWith("_")) return 1
        return 2
      }
      const diff = rank(a) - rank(b)
      if (diff) return diff
      return a.localeCompare(b)
    })

  const selected: Record<string, string> = {}
  for (const [key, value] of sorted) {
    selected[key] = value
    if (serialize(selected)) continue
    delete selected[key]
  }

  if (Object.keys(selected).length === 0) return
  return selected
}

export function encodeAttachEnv(input: NodeJS.ProcessEnv) {
  const env = normalize(input)
  if (!env) return
  const full = serialize(env)
  if (full) return full

  const reduced = fallback(env)
  if (!reduced) return
  return serialize(reduced)
}

export function decodeAttachEnv(value?: string) {
  if (!value || value.length > MAX_HEADER) return
  try {
    if (value.startsWith(FORMAT_GZIP)) {
      const body = value.slice(FORMAT_GZIP.length)
      const json = gunzipSync(Buffer.from(body, "base64")).toString("utf8")
      return normalize(JSON.parse(json))
    }

    const body = value.startsWith(FORMAT_JSON) ? value.slice(FORMAT_JSON.length) : value
    const json = Buffer.from(body, "base64").toString("utf8")
    return normalize(JSON.parse(json))
  } catch {
    return
  }
}
