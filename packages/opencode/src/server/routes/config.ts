import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { Instance } from "../../project/instance"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { SessionPrompt } from "../../session/prompt"
import { SessionStatus } from "../../session/status"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"

const log = Log.create({ service: "server" })

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.get())
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        await Config.update(config)
        return c.json(config)
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
        return c.json({
          providers: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
        })
      },
    )
    .post(
      "/reload",
      describeRoute({
        summary: "Reload configuration",
        description:
          "Reload all configuration files (opencode.jsonc, .opencode/) and plugins, and restart all instances without restarting the TUI.",
        operationId: "config.reload",
        responses: {
          200: {
            description: "Configuration reloaded successfully",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.boolean() })),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("reloading configuration")
        // Cancel active sessions first to abort any in-flight streams
        for (const [sessionID, info] of Object.entries(SessionStatus.list())) {
          if (info.type !== "idle") {
            SessionPrompt.cancel(sessionID, MessageV2.ABORT_REASON.CONFIG_RELOAD)
          }
        }
        // Wait for all aborted loops to finish saving their messages
        await SessionPrompt.flush()
        Config.global.reset()
        await Instance.disposeAll()
        // Drain incomplete messages AFTER dispose to catch any that arrived during reload.
        // Without this, messages sent during reload appear as "QUEUED" in the TUI
        // because the pending memo finds an old assistant message with time.completed undefined.
        await Session.drainIncomplete(MessageV2.ABORT_REASON.CONFIG_RELOAD)
        return c.json({ success: true })
      },
    ),
)
