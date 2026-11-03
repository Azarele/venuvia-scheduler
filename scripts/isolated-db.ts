// Points DATABASE_URL at a separate database (e.g. venuvia_test, venuvia_eval) so
// tests and evals never touch your dev data. Creates it on first use.
import { readFile } from "node:fs/promises";
import pg from "pg";

export async function useIsolatedDatabase(suffix: "test" | "uitest" | "eval"): Promise<string> {
  const base = process.env.DATABASE_URL ?? "postgres://venuvia:venuvia@localhost:5432/venuvia";
  const url = new URL(base);
  const name = `${url.pathname.slice(1)}_${suffix}`.replace(/[^a-zA-Z0-9_]/g, "_");

  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (!rowCount) await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  return name;
}

/** Drops and recreates all tables with the demo data. Refuses to touch anything but a _test/_eval database. */
export async function resetDatabase(db: { query: (sql: string) => Promise<{ rows: { name: string }[] }> }): Promise<void> {
  const { rows } = await db.query("select current_database() as name");
  if (!/_(test|uitest|eval)$/.test(rows[0].name)) throw new Error(`Refusing to reset "${rows[0].name}": tests and evals only reset *_test / *_uitest / *_eval databases.`);
  await db.query(await readFile("db/schema.sql", "utf8"));
  // One multi-statement query runs on one connection, so the time zone applies to the seed.
  const timezone = (process.env.BUSINESS_TIMEZONE ?? "Europe/Warsaw").replace(/[^A-Za-z0-9_/+-]/g, "");
  await db.query(`set time zone '${timezone}';\n${await readFile("db/seed.sql", "utf8")}`);
}
