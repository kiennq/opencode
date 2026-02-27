const MAX_HEADER = 128 * 1024

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

export function encodeAttachEnv(input: NodeJS.ProcessEnv) {
  const env = normalize(input)
  if (!env) return
  const encoded = Buffer.from(JSON.stringify(env), "utf8").toString("base64")
  if (encoded.length > MAX_HEADER) return
  return encoded
}

export function decodeAttachEnv(value?: string) {
  if (!value || value.length > MAX_HEADER) return
  try {
    const json = Buffer.from(value, "base64").toString("utf8")
    return normalize(JSON.parse(json))
  } catch {
    return
  }
}
