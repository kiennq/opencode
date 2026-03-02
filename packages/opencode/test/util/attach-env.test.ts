import { describe, expect, test } from "bun:test"
import { decodeAttachEnv, encodeAttachEnv } from "../../src/util/attach-env"

describe("attach env header", () => {
  test("round-trips encoded env", () => {
    const encoded = encodeAttachEnv({
      FOO: "bar",
      EMPTY: "",
    })

    expect(encoded).toBeTruthy()
    expect(decodeAttachEnv(encoded)).toEqual({
      FOO: "bar",
      EMPTY: "",
    })
  })

  test("decodes legacy base64 json payload", () => {
    const legacy = Buffer.from(JSON.stringify({ LEGACY: "1" }), "utf8").toString("base64")
    expect(decodeAttachEnv(legacy)).toEqual({ LEGACY: "1" })
  })

  test("uses gzip format for larger payloads", () => {
    const encoded = encodeAttachEnv(
      Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`K_${i}`, `value-${i}-${"x".repeat(40)}`])),
    )

    expect(encoded?.startsWith("gz:")).toBe(true)
    expect(decodeAttachEnv(encoded)).toBeTruthy()
  })

  test("skips payloads that exceed header limit", () => {
    const huge = Array.from({ length: 40000 }, (_, i) => `${i.toString(36)}-${(i * 17).toString(36)}`).join("|")
    const encoded = encodeAttachEnv({ HUGE: huge })
    expect(encoded).toBeUndefined()
  })

  test("keeps underscore vars in fallback payload", () => {
    const input = Object.fromEntries(
      Array.from({ length: 3000 }, (_, i) => [`JUNK_${i}`, `value-${i}-${"x".repeat(200)}`]),
    )
    input._TOOLPATH = "C:\\tools\\my-tool"

    const encoded = encodeAttachEnv(input)
    const decoded = decodeAttachEnv(encoded)

    expect(encoded).toBeTruthy()
    expect(decoded?._TOOLPATH).toBe("C:\\tools\\my-tool")
  })

  test("keeps MSBuild vars in fallback payload", () => {
    const input = Object.fromEntries(
      Array.from({ length: 3000 }, (_, i) => [`JUNK_${i}`, `value-${i}-${"x".repeat(200)}`]),
    )
    input.MSBuildToolsPath_170 = "C:\\Program Files\\Microsoft Visual Studio\\MSBuild"

    const encoded = encodeAttachEnv(input)
    const decoded = decodeAttachEnv(encoded)

    expect(encoded).toBeTruthy()
    expect(decoded?.MSBuildToolsPath_170).toBe("C:\\Program Files\\Microsoft Visual Studio\\MSBuild")
  })
})
