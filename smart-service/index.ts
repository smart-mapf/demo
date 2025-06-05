import { initTRPC, tracked, type TrackedEnvelope } from "@trpc/server";
import { run, type Output } from "smart";
import { createBunWSHandler } from "trpc-bun-adapter";
import { z } from "zod";

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

const t = initTRPC.create();

export const appRouter = t.router({
  run: t.procedure
    .input(
      z.object({
        flipXY: z.boolean().default(false),
        agents: z.number().min(1, "Agent count must be at least 1"),
        scen: z.string().nonempty("Scen file must not be empty"),
        map: z.string().nonempty("Map file must not be empty"),
        paths: z.string().nonempty("Paths file must not be empty"),
        lastEventId: z.string().nullish(),
      })
    )
    .subscription(async function* (
      opts
    ): AsyncGenerator<TrackedEnvelope<Output[]>> {
      const track = tracker<Output[]>();
      const { input } = opts;
      if (input.lastEventId) {
        // Disconnect
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
});

export type AppRouter = typeof appRouter;

const ws = createBunWSHandler({ router: appRouter });

Bun.serve({
  port: 80,
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
