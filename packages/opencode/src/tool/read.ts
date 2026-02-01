import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { InstructionPrompt } from "../session/instruction"
import { File } from "@opencode-ai/runtime"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z
    .object({
      filePath: z.string().describe("The path to the file to read").optional(),
      filePaths: z.array(z.string()).describe("Paths to files to read").optional(),
      offset: z.coerce.number().describe("The line number to start reading from (0-based)").optional(),
      limit: z.coerce.number().describe("The number of lines to read (defaults to 2000)").optional(),
    })
    .refine((value) => value.filePath || (value.filePaths && value.filePaths.length > 0), {
      message: "filePath or filePaths is required",
    })
    .refine((value) => !(value.filePath && value.filePaths && value.filePaths.length > 0), {
      message: "Use filePath or filePaths, not both",
    }),
  async execute(params, ctx) {
    const hasPath = Boolean(params.filePath)
    const hasPaths = Boolean(params.filePaths?.length)
    if (hasPath && hasPaths) throw new Error("Use filePath or filePaths, not both")
    const paths = hasPaths ? params.filePaths! : hasPath ? [params.filePath!] : []
    if (paths.length === 0) throw new Error("filePath or filePaths is required")

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0

    const readOne = async (value: string) => {
      const filepath = path.isAbsolute(value) ? value : path.join(process.cwd(), value)
      const title = path.relative(Instance.worktree, filepath)

      await assertExternalDirectory(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
      })

      await ctx.ask({
        permission: "read",
        patterns: [filepath],
        always: ["*"],
        metadata: {},
      })

      if (!(await File.exists(filepath))) {
        const dir = path.dirname(filepath)
        const base = path.basename(filepath)

        const dirEntries = fs.readdirSync(dir)
        const suggestions = dirEntries
          .filter(
            (entry) =>
              entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
          )
          .map((entry) => path.join(dir, entry))
          .slice(0, 3)

        if (suggestions.length > 0) {
          throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
        }

        throw new Error(`File not found: ${filepath}`)
      }

      const instructions = await InstructionPrompt.resolve(ctx.messages, filepath, ctx.messageID)

      // Get file stat and mime type
      const stat = await File.stat(filepath)
      const mimeType = getMimeType(filepath)

      // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
      const isImage =
        mimeType.startsWith("image/") && mimeType !== "image/svg+xml" && mimeType !== "image/vnd.fastbidsheet"
      const isPdf = mimeType === "application/pdf"
      if (isImage || isPdf) {
        const mime = mimeType
        const msg = `${isImage ? "Image" : "PDF"} read successfully`
        const fileBytes = await File.readBytes(filepath)
        return {
          title,
          output: msg,
          metadata: {
            preview: msg,
            truncated: false,
            ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
          },
          attachments: [
            {
              type: "file" as const,
              mime,
              url: `data:${mime};base64,${Buffer.from(fileBytes).toString("base64")}`,
            },
          ],
          instructions,
        }
      }

      const isBinary = await isBinaryFile(filepath, stat)
      if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

      const lines = await File.read(filepath).then((text) => text.split("\n"))

      const raw: string[] = []
      let bytes = 0
      let truncatedByBytes = false
      for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
        const line = lines[i].length > MAX_LINE_LENGTH ? lines[i].substring(0, MAX_LINE_LENGTH) + "..." : lines[i]
        const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
        if (bytes + size > MAX_BYTES) {
          truncatedByBytes = true
          break
        }
        raw.push(line)
        bytes += size
      }

      const content = raw.map((line, index) => {
        return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
      })
      const preview = raw.slice(0, 20).join("\n")

      let output = "<file>\n"
      output += content.join("\n")

      const totalLines = lines.length
      const lastReadLine = offset + raw.length
      const hasMoreLines = totalLines > lastReadLine
      const truncated = hasMoreLines || truncatedByBytes

      if (truncatedByBytes) {
        output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
      } else if (hasMoreLines) {
        output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
      } else {
        output += `\n\n(End of file - total ${totalLines} lines)`
      }
      output += "\n</file>"

      // just warms the lsp client
      LSP.touchFile(filepath, false)
      FileTime.read(ctx.sessionID, filepath)

      return {
        title,
        output,
        metadata: {
          preview,
          truncated,
          ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
        },
        instructions,
      }
    }

    if (paths.length === 1) {
      const result = await readOne(paths[0])
      const { instructions, ...rest } = result
      if (instructions && instructions.length > 0) {
        rest.output += `\n\n<system-reminder>\n${instructions.map((i) => i.content).join("\n\n")}\n</system-reminder>`
      }
      return rest
    }

    const results = await Promise.all(paths.map((value) => readOne(value)))

    let output = results.map((result) => result.output).join("\n\n")
    const preview = results.map((result) => result.metadata.preview).join("\n\n")
    const truncated = results.some((result) => result.metadata.truncated)
    const title = results.map((result) => result.title).join(", ")
    const attachments = results.flatMap((result) => result.attachments ?? [])
    const allInstructions = results.flatMap((result) => result.instructions ?? [])
    const allLoaded = results.flatMap((result) => result.metadata.loaded ?? [])

    if (allInstructions.length > 0) {
      output += `\n\n<system-reminder>\n${allInstructions.map((i) => i.content).join("\n\n")}\n</system-reminder>`
    }

    if (attachments.length === 0) {
      return {
        title,
        output,
        metadata: {
          preview,
          truncated,
          ...(allLoaded.length > 0 && { loaded: allLoaded }),
        },
      }
    }

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
        ...(allLoaded.length > 0 && { loaded: allLoaded }),
      },
      attachments,
    }
  },
})

async function isBinaryFile(filepath: string, stat: import("@opencode-ai/runtime").FileStat): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  const fileSize = stat.size
  if (fileSize === 0) return false

  // Only read the first 4KB to check for binary content, not the entire file
  const bufferSize = Math.min(4096, fileSize)
  const bytes = new Uint8Array(bufferSize)
  const fd = fs.openSync(filepath, "r")
  try {
    fs.readSync(fd, bytes, 0, bufferSize, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (bytes.length === 0) return false

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}

function getMimeType(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    // Images
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".fbs": "image/vnd.fastbidsheet",
    // Documents
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    // Text
    ".txt": "text/plain",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".json": "application/json",
    ".xml": "application/xml",
    ".md": "text/markdown",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
  }
  return mimeTypes[ext] || "application/octet-stream"
}
