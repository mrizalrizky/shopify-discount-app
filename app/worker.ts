import PgBoss from "pg-boss";
import prisma from "./db.server";
import { createJobHandlers, QUEUES } from "./jobs/handlers";
import { RUN_JOB_EXPIRE_SECONDS } from "./jobs/queue-config";
import { unauthenticated } from "./shopify.server";
import { adminGraphql, createGraphqlGateway } from "./shopify/graphql-gateway";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

/**
 * Concurrent jobs per run queue in this process, so one shop's long restore does not hold up
 * every other shop. Each `work` registration is an independent poller fetching one job at a
 * time (batchSize stays 1: a batch would complete or fail all its jobs together).
 */
const RUN_QUEUE_CONCURRENCY = Math.max(1, Math.floor(Number(process.env.RUN_QUEUE_CONCURRENCY)) || 4);

const boss = new PgBoss(connectionString);
boss.on("error", (error) => console.error("[pg-boss]", error));
await boss.start();
await boss.createQueue(QUEUES.tick);
// "stately" queues enforce singletonKey: at most one queued and one active job per run.
// Caveat: a queued job whose run already has an active job cannot be activated, and pg-boss
// fetches strictly in creation order, so it blocks the queue head until the active job ends.
// The tick therefore never sends a job for a run whose lease is live (handlers.ts).
for (const name of [QUEUES.start, QUEUES.stop, QUEUES.refresh]) {
  await boss.createQueue(name, { name, policy: "stately", expireInSeconds: RUN_JOB_EXPIRE_SECONDS });
}

const handlers = createJobHandlers({
  db: prisma,
  now: () => new Date(),
  gatewayFor: async (shop) => {
    const { admin } = await unauthenticated.admin(shop);
    return createGraphqlGateway(adminGraphql(admin));
  },
  send: async (queue, data) => {
    // With the stately queue policy, singletonKey dedupes re-sends of the same run (one queued + one active).
    // No pg-boss retries: the tick re-sends every unfinished stop, stranded start and due refresh each
    // minute once the run lease is free. A job waiting in pg-boss "retry" state would be a second queued
    // job for the run next to the tick's (stately allows one per state) and could block the queue head.
    // expireInSeconds is set per job too: createQueue does not change a queue that already exists.
    await boss.send(queue, data, { singletonKey: data.runId, retryLimit: 0, expireInSeconds: RUN_JOB_EXPIRE_SECONDS });
  },
});

type RunJob = { runId: string };

await boss.work(QUEUES.tick, async () => handlers.tick());
for (let i = 0; i < RUN_QUEUE_CONCURRENCY; i++) {
  await boss.work<RunJob>(QUEUES.start, async ([job]) => handlers.startRun(job.data.runId));
  await boss.work<RunJob>(QUEUES.stop, async ([job]) => handlers.stopRun(job.data.runId));
  await boss.work<RunJob>(QUEUES.refresh, async ([job]) => handlers.refreshRun(job.data.runId));
}
await boss.schedule(QUEUES.tick, "* * * * *");

// Remaining assumptions:
// - Several worker processes may run: the per-run lease and conditional claims keep them safe,
//   and the per-shop advisory lock serializes overlap checks. They are not needed for throughput.
// - A job that runs past its lease without reaching a guard (e.g. one Shopify write stuck for
//   over LEASE_MS) can still overlap a takeover; the claims then refuse the stale job's DB update.
// - A tick landing between a job's activation and its lease claim (one DB round trip) can still
//   queue a duplicate behind it, holding the queue head until that job finishes. Rare; not unsafe.
// - A process killed mid-job leaves the run leased until the lease expires (LEASE_MS); the tick
//   re-sends the job after that.

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`Sale worker stopping (${signal})`);
  try {
    // Stop fetching, wait for active jobs (up to pg-boss's timeout), then fail the rest; the tick re-sends them.
    await boss.stop({ graceful: true });
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log("Sale worker started");
