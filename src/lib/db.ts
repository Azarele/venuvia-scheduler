import pg from "pg";

// One shared pool. Stored on globalThis so Next.js hot reloads in dev don't open new pools.
const globalForDb = globalThis as unknown as { pgPool?: pg.Pool };

export const pool =
  globalForDb.pgPool ??
  new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://venuvia:venuvia@localhost:5432/venuvia",
    max: 5,
  });

globalForDb.pgPool = pool;
