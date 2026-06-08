import { initTRPC, tracked, type TrackedEnvelope } from "@trpc/server";
import { run, runVicon, type Output } from "smart";
import { getPort } from "get-port-please";
import { createBunWSHandler } from "trpc-bun-adapter";
import { z } from "zod";
import { write } from "bun";
import { join } from "path";

/**
 * Wraps each yielded message batch with a unique id so tRPC can track/resume
 * subscriptions over WebSocket.
 */
const tracker = <T extends object>() => {
  let i = 0;
  return async function* (t: T | AsyncIterableIterator<T>) {
    if (Symbol.asyncIterator in t) {
      for await (const t1 of t) {
        yield tracked(`${i++}`, t1);
      }
    } else {
      yield tracked(`${i++}`, t);
    }
  };
};

// tRPC instance — all server endpoints are built from this.
const t = initTRPC.create();

export const appRouter = t.router({
  /**
   * PROCEDURE: run
   * Full Argos physics simulation. Client sends map/scenario/solution files.
   * Server spawns the simulator and streams ticks back.
   */
  run: t.procedure
    .input(
      z.object({
        flipXY: z.boolean().default(false),
        agents: z.number().min(1, "Agent count must be at least 1"),
        scen: z.string().nonempty("Scen file must not be empty"),
        map: z.string().nonempty("Map file must not be empty"),
        paths: z.string().nonempty("Paths file must not be empty"),
        acceleration: z.number().default(10),
        angularMaxSpeed: z.number().default(7.5),
        angularAcceleration: z.number().default(3),
        maxSpeed: z.number().default(500),
        lastEventId: z.string().nullish(),
      })
    )
    .subscription(async function* (
      opts
    ): AsyncGenerator<TrackedEnvelope<Output[]>> {
      const track = tracker<Output[]>();
      const { input } = opts;
      if (input.lastEventId) {
        yield* track([
          { type: "message", content: "Request cancelled: disconnected" },
        ]);
        return;
      }
      const { values, dispose, errors } = await run(input);
      try {
        yield* track(values());
        yield* track([{ type: "message", content: await errors }]);
      } catch (e) {
        yield* track([{ type: "error", error: e }]);
      } finally {
        await dispose();
      }
    }),

  /**
   * PROCEDURE: runVicon
   * Mock Vicon replay. Client sends a JSON trajectory string; server parses it
   * and streams one frame at a time — same tick format as `run`, so the client
   * visualiser can reuse the same onData handler.
   *
   * Later: replace JSON input with a real Vicon connection inside runVicon().
   */
  runVicon: t.procedure
    .input(
      z.object({
        /** Raw JSON file contents uploaded from the visualiser. */
        trajectory: z.string().min(1),
        flipXY: z.boolean().default(false),
        /** Delay between frames in ms (simulates real-time motion capture). */
        frameDelayMs: z.number().min(0).default(100),
        lastEventId: z.string().nullish(),
      })
    )
    .subscription(async function* (
      opts
    ): AsyncGenerator<TrackedEnvelope<Output[]>> {
      const track = tracker<Output[]>();
      const { input } = opts;

      if (input.lastEventId) {
        yield* track([
          { type: "message", content: "Request cancelled: disconnected" },
        ]);
        return;
      }

      const { values, dispose } = await runVicon(input);
      try {
        // Stream each frame batch to the client as it is produced.
        yield* track(values());
      } catch (e) {
        yield* track([{ type: "error", error: e }]);
      } finally {
        await dispose();
      }
    }),
});

/** Exported so the visualiser client gets typed client.run / client.runVicon. */
export type AppRouter = typeof appRouter;

const ws = createBunWSHandler({ router: appRouter });

// Pick the first free port from 8080 upward (avoids EADDRINUSE from stale processes).
const PORT = await getPort({ port: Number(process.env.PORT) || 8080 });

// Tell the visualiser which port we landed on (read by src/client/trpc.ts in dev).
const portFile = join(import.meta.dir, "../smart-visualiser/public/ws-port.txt");
await write(portFile, String(PORT));

Bun.serve({
  port: PORT,
  fetch(request, server) {
    if (server.upgrade(request, { data: { req: request } })) {
      return;
    }
    return new Response("Please use websocket protocol", { status: 404 });
  },
  websocket: {
    ...ws,
    perMessageDeflate: true,
    backpressureLimit: 16 * 1024 * 1024 * 1024,
  },
});

console.log(`smart-service listening on ws://localhost:${PORT}`);
