import { LEASE_MS } from "./handlers";

/**
 * How long pg-boss lets a run job stay active before expiring it (marking it failed).
 *
 * Just above the run lease: a job past its lease is already fenced by the lease guard, so a longer
 * expiry buys no safety. Keeping it short matters because run queues are "stately": a job left
 * active by a killed worker blocks every queued job behind it in that queue (all shops) until it
 * expires.
 */
export const RUN_JOB_EXPIRE_SECONDS = Math.ceil(LEASE_MS / 1000) + 5 * 60;
