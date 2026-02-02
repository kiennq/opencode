import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Pty } from "@/pty"
import { Storage } from "../../storage/storage"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const PtyRoutes = lazy(() => {
  // Create the base app with REST endpoints (work on all runtimes)
  const app = new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List PTY sessions",
        description: "Get a list of all active pseudo-terminal (PTY) sessions managed by OpenCode.",
        operationId: "pty.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Pty.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Pty.list())
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create PTY session",
        description: "Create a new pseudo-terminal (PTY) session for running shell commands and processes.",
        operationId: "pty.create",
        responses: {
          200: {
            description: "Created session",
            content: {
              "application/json": {
                schema: resolver(Pty.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Pty.CreateInput),
      async (c) => {
        const info = await Pty.create(c.req.valid("json"))
        return c.json(info)
      },
    )
    .get(
      "/:ptyID",
      describeRoute({
        summary: "Get PTY session",
        description: "Retrieve detailed information about a specific pseudo-terminal (PTY) session.",
        operationId: "pty.get",
        responses: {
          200: {
            description: "Session info",
            content: {
              "application/json": {
                schema: resolver(Pty.Info),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: z.string() })),
      async (c) => {
        const info = Pty.get(c.req.valid("param").ptyID)
        if (!info) {
          throw new Storage.NotFoundError({ message: "Session not found" })
        }
        return c.json(info)
      },
    )
    .put(
      "/:ptyID",
      describeRoute({
        summary: "Update PTY session",
        description: "Update properties of an existing pseudo-terminal (PTY) session.",
        operationId: "pty.update",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Pty.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ ptyID: z.string() })),
      validator("json", Pty.UpdateInput),
      async (c) => {
        const info = await Pty.update(c.req.valid("param").ptyID, c.req.valid("json"))
        return c.json(info)
      },
    )
    .delete(
      "/:ptyID",
      describeRoute({
        summary: "Remove PTY session",
        description: "Remove and terminate a specific pseudo-terminal (PTY) session.",
        operationId: "pty.remove",
        responses: {
          200: {
            description: "Session removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: z.string() })),
      async (c) => {
        await Pty.remove(c.req.valid("param").ptyID)
        return c.json(true)
      },
    )

  // Add WebSocket connect route only on Bun (requires upgradeWebSocket from hono/bun)
  if (typeof Bun !== "undefined") {
    // We need to dynamically require this at runtime since it's Bun-only
    // Using require() here since we're in a sync context and already checked for Bun
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { upgradeWebSocket } = require("hono/bun") as typeof import("hono/bun")

    return app.get(
      "/:ptyID/connect",
      describeRoute({
        summary: "Connect to PTY session",
        description: "Establish a WebSocket connection to interact with a pseudo-terminal (PTY) session in real-time.",
        operationId: "pty.connect",
        responses: {
          200: {
            description: "Connected session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: z.string() })),
      upgradeWebSocket((c) => {
        const id = c.req.param("ptyID")
        let handler: ReturnType<typeof Pty.connect>
        if (!Pty.get(id)) throw new Error("Session not found")
        return {
          onOpen(_event, ws) {
            handler = Pty.connect(id, ws)
          },
          onMessage(event) {
            handler?.onMessage(String(event.data))
          },
          onClose() {
            handler?.onClose()
          },
        }
      }),
    )
  }

  // For Node.js/Deno, return endpoint that indicates WebSocket not supported
  return app.get(
    "/:ptyID/connect",
    describeRoute({
      summary: "Connect to PTY session",
      description:
        "Establish a WebSocket connection to interact with a pseudo-terminal (PTY) session in real-time. NOTE: WebSocket connections are only supported on Bun runtime.",
      operationId: "pty.connect",
      responses: {
        501: {
          description: "WebSocket not supported on this runtime",
          content: {
            "application/json": {
              schema: resolver(z.object({ error: z.string() })),
            },
          },
        },
        ...errors(404),
      },
    }),
    validator("param", z.object({ ptyID: z.string() })),
    async (c) => {
      return c.json({ error: "PTY WebSocket connections are only supported on Bun runtime" }, 501)
    },
  )
})
