import PgBoss from "pg-boss";
import prisma from "./db.server";
import { createJobHandlers, QUEUES } from "./jobs/handlers";
import { unauthenticated } from "./shopify.server";
import { adminGraphql, createGraphqlGateway } from "./shopify/graphql-gateway";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const boss = new PgBoss(connectionString);
boss.on("error", (error) => console.error("[pg-boss]", error));
await boss.start();
await boss.createQueue(QUEUES.tick);
// "stately" queues enforce singletonKey: at most one queued and one active job per run.
for (const name of [QUEUES.start, QUEUES.stop, QUEUES.refresh]) await boss.createQueue(name, { name, policy: "stately" });

const handlers = createJobHandlers({
  db: prisma,
  now: () => new Date(),
  gatewayFor: async (shop) => {
    const { admin } = await unauthenticated.admin(shop);
    return createGraphqlGateway(adminGraphql(admin));
  },
  send: async (queue, data) => {
    // With the stately queue policy, singletonKey dedupes re-sends of the same run (one queued + one active).
    await boss.send(queue, data, { singletonKey: data.runId, retryLimit: 5, retryBackoff: true });
  },
});

type RunJob = { runId: string };

await boss.work(QUEUES.tick, async () => handlers.tick());
await boss.work<RunJob>(QUEUES.start, async ([job]) => handlers.startRun(job.data.runId));
await boss.work<RunJob>(QUEUES.stop, async ([job]) => handlers.stopRun(job.data.runId));
await boss.work<RunJob>(QUEUES.refresh, async ([job]) => handlers.refreshRun(job.data.runId));
await boss.schedule(QUEUES.tick, "* * * * *");

console.log("Sale worker started");
