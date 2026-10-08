import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "./db";

describe("integration database", () => {
  beforeEach(resetDb);

  it("connects to the test database and round-trips a session", async () => {
    await testDb.session.create({
      data: { id: "s1", shop: "demo.myshopify.com", state: "x", accessToken: "t" },
    });
    expect(await testDb.session.count()).toBe(1);
    const [{ db }] = await testDb.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(db).toBe("salecodes_test");
  });

  it("starts each test empty", async () => {
    expect(await testDb.session.count()).toBe(0);
  });
});
