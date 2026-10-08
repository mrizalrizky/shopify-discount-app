import { PrismaClient } from "@prisma/client";

export const testDb = new PrismaClient();

const TABLES = ["Session"];

export async function resetDb(): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(", ");
  await testDb.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
