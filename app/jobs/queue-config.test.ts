import { describe, expect, it } from "vitest";
import { LEASE_MS } from "./handlers";
import { RUN_JOB_EXPIRE_SECONDS } from "./queue-config";

describe("run job expiry", () => {
  it("outlasts the run lease, so pg-boss does not expire a job that still holds its lease", () => {
    expect(RUN_JOB_EXPIRE_SECONDS * 1000).toBeGreaterThan(LEASE_MS);
  });

  it("stays close to the lease, so a killed worker's job cannot block a stately queue for hours", () => {
    expect(RUN_JOB_EXPIRE_SECONDS * 1000).toBeLessThanOrEqual(LEASE_MS + 10 * 60 * 1000);
  });
});
