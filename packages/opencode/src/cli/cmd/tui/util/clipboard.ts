import { platform, release } from "os"
import clipboardy from "clipboardy"
import { lazy } from "../../../../util/lazy.js"
import { tmpdir } from "os"
import path from "path"
import { File, Process } from "@opencode-ai/runtime"

export namespace Clipboard {
  export interface Content {
    data: string
    mime: string
  }

  export async function read(): Promise<Content | undefined> {
    const os = platform()

    if (os === "darwin") {
      const tmpfile = path.join(tmpdir(), "opencode-clipboard.png")
      try {
        await Process.exec(
          `osascript -e 'set imageData to the clipboard as "PNGf"' -e 'set fileRef to open for access POSIX file "${tmpfile}" with write permission' -e 'set eof fileRef to 0' -e 'write imageData to fileRef' -e 'close access fileRef'`,
          { nothrow: true, quiet: true },
        )
        const buffer = await File.readBytes(tmpfile)
        return { data: Buffer.from(buffer).toString("base64"), mime: "image/png" }
      } catch {
      } finally {
        await Process.exec(`rm -f "${tmpfile}"`, { nothrow: true, quiet: true })
      }
    }

    if (os === "win32" || release().includes("WSL")) {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
      const result = await Process.exec(`powershell.exe -NonInteractive -NoProfile -command "${script}"`, {
        nothrow: true,
      })
      const base64 = result.stdout
      if (base64) {
        const imageBuffer = Buffer.from(base64.trim(), "base64")
        if (imageBuffer.length > 0) {
          return { data: imageBuffer.toString("base64"), mime: "image/png" }
        }
      }
    }

    if (os === "linux") {
      const waylandResult = await Process.exec("wl-paste -t image/png", { nothrow: true })
      if (waylandResult.success && waylandResult.stdout) {
        const wayland = Buffer.from(waylandResult.stdout, "binary")
        if (wayland.byteLength > 0) {
          return { data: wayland.toString("base64"), mime: "image/png" }
        }
      }
      const x11Result = await Process.exec("xclip -selection clipboard -t image/png -o", { nothrow: true })
      if (x11Result.success && x11Result.stdout) {
        const x11 = Buffer.from(x11Result.stdout, "binary")
        if (x11.byteLength > 0) {
          return { data: x11.toString("base64"), mime: "image/png" }
        }
      }
    }

    const text = await clipboardy.read().catch(() => {})
    if (text) {
      return { data: text, mime: "text/plain" }
    }
  }

  const getCopyMethod = lazy(() => {
    const os = platform()

    if (os === "darwin" && Process.which("osascript")) {
      console.log("clipboard: using osascript")
      return async (text: string) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        await Process.exec(`osascript -e 'set the clipboard to "${escaped}"'`, { nothrow: true, quiet: true })
      }
    }

    if (os === "linux") {
      if (process.env["WAYLAND_DISPLAY"] && Process.which("wl-copy")) {
        console.log("clipboard: using wl-copy")
        return async (text: string) => {
          const proc = Process.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
          const writer = proc.stdin?.getWriter()
          if (writer) {
            await writer.write(new TextEncoder().encode(text))
            await writer.close()
          }
          await proc.exited.catch(() => {})
        }
      }
      if (Process.which("xclip")) {
        console.log("clipboard: using xclip")
        return async (text: string) => {
          const proc = Process.spawn(["xclip", "-selection", "clipboard"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          const writer = proc.stdin?.getWriter()
          if (writer) {
            await writer.write(new TextEncoder().encode(text))
            await writer.close()
          }
          await proc.exited.catch(() => {})
        }
      }
      if (Process.which("xsel")) {
        console.log("clipboard: using xsel")
        return async (text: string) => {
          const proc = Process.spawn(["xsel", "--clipboard", "--input"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          const writer = proc.stdin?.getWriter()
          if (writer) {
            await writer.write(new TextEncoder().encode(text))
            await writer.close()
          }
          await proc.exited.catch(() => {})
        }
      }
    }

    if (os === "win32") {
      console.log("clipboard: using powershell")
      return async (text: string) => {
        // Pipe via stdin to avoid PowerShell string interpolation ($env:FOO, $(), etc.)
        const proc = Process.spawn(
          [
            "powershell.exe",
            "-NonInteractive",
            "-NoProfile",
            "-Command",
            "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
          ],
          {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          },
        )

        const writer = proc.stdin?.getWriter()
        if (writer) {
          await writer.write(new TextEncoder().encode(text))
          await writer.close()
        }
        await proc.exited.catch(() => {})
      }
    }

    console.log("clipboard: no native support")
    return async (text: string) => {
      await clipboardy.write(text).catch(() => {})
    }
  })

  export async function copy(text: string): Promise<void> {
    await getCopyMethod()(text)
  }
}
