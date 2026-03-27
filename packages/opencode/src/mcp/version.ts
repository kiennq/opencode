import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"

const VERSION = /^\d{4}-\d{2}-\d{2}$/

export function compatVersion(version: string) {
  if (!VERSION.test(version)) return false
  if (version > LATEST_PROTOCOL_VERSION) return false
  const date = new Date(version + "T00:00:00.000Z")
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(version)
}

export function compatTransport<T extends Transport>(base: T): T {
  let init = false
  let server: string | undefined
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "send") {
        return async (message: JSONRPCMessage, opts?: TransportSendOptions) => {
          init = !!("method" in message && message.method === "initialize")
          await target.send(message, opts)
        }
      }
      if (prop === "setProtocolVersion") {
        return (version: string) => {
          target.setProtocolVersion?.(server ?? version)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
    set(target, prop, value, receiver) {
      if (prop === "onmessage") {
        target.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
          if (
            init &&
            "result" in message &&
            message.result &&
            typeof message.result === "object" &&
            "protocolVersion" in message.result &&
            typeof message.result.protocolVersion === "string"
          ) {
            server = message.result.protocolVersion
            if (compatVersion(server)) {
              value?.(
                {
                  ...message,
                  result: {
                    ...message.result,
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                  },
                },
                extra,
              )
              return true
            }
          }
          value?.(message, extra)
          return true
        }
        return true
      }
      return Reflect.set(target, prop, value, receiver)
    },
  }) as T
}
