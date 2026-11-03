import pg from "pg";

// One shared pool, created on first use so DATABASE_URL is read at that moment
// (tests and evals switch it to a separate database before any query runs).
// Stored on globalThis so Next.js hot reloads in dev don't open new pools.
const globalForDb = globalThis as unknown as { pgPool?: pg.Pool };

function getPool(): pg.Pool {
  return (globalForDb.pgPool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://venuvia:venuvia@localhost:5432/venuvia",
    max: 10, // one per in-flight chat request holds a conversation lock
  }));
}

export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop) {
    const real = getPool();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
