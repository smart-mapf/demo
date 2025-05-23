import { initTRPC } from "@trpc/server";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { run, type Output } from "smart";
import { WebSocketServer } from "ws";
import { z } from "zod";

const t = initTRPC.create();

export const appRouter = t.router({
  run: t.procedure
    .input(
      z.object({
        agents: z.number().min(1, "Agent count must be at least 1"),
        scen: z.string().nonempty("Scen file must not be empty"),
        map: z.string().nonempty("Map file must not be empty"),
        paths: z.string().nonempty("Paths file must not be empty"),
      })
    )
    .subscription(async function* (opts): AsyncGenerator<Output[]> {
      const { input } = opts;
      const { values, dispose, errors } = await run(input);
      try {
        yield* values();
        yield [{ type: "message", content: await errors() }];
      } catch (e) {
        yield [{ type: "error", error: e }];
      } finally {
        await dispose();
      }
    }),
});

export type AppRouter = typeof appRouter;

const wss = new WebSocketServer({ port: 8194, perMessageDeflate: true });

const handler = applyWSSHandler({
  wss,
  router: appRouter,
  // Enable heartbeat messages to keep connection open (disabled by default)
  keepAlive: {
    enabled: true,
    // server ping message interval in milliseconds
    pingMs: 30000,
    // connection is terminated if pong message is not received in this many milliseconds
    pongWaitMs: 1000 * 60 * 60,
  },
});

wss.on("error", (e) => {
  console.error(e);
});

process.on("SIGTERM", () => {
  handler.broadcastReconnectNotification();
  wss.close();
});
