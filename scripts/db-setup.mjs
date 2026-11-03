// Creates the tables and loads demo data: `npm run db:setup`.
// Safe to re-run at any time to reset the database to the demo state.
import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgres://venuvia:venuvia@localhost:5432/venuvia";
const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  // Seed times ("10:00 tomorrow") are in the salon's timezone, the same one the app uses.
  const timezone = process.env.BUSINESS_TIMEZONE ?? "Europe/Warsaw";
  if (!/^[A-Za-z0-9_/+-]+$/.test(timezone)) throw new Error(`BUSINESS_TIMEZONE "${timezone}" doesn't look like a timezone name.`);
  await client.query(await readFile("db/schema.sql", "utf8"));
  console.log("✓ ran db/schema.sql");
  await client.query(`set time zone '${timezone}';\n${await readFile("db/seed.sql", "utf8")}`);
  console.log(`✓ ran db/seed.sql (times in ${timezone})`);
  const { rows } = await client.query(
    "select (select count(*) from users) users, (select count(*) from clients) clients, (select count(*) from bookings) bookings",
  );
  console.log(`Database ready: ${rows[0].users} users, ${rows[0].clients} clients, ${rows[0].bookings} bookings.`);
} catch (error) {
  console.error(`Database setup failed (${url.replace(/:[^:@/]+@/, ":***@")}):\n  ${error.message}`);
  console.error("Is Postgres running, and does DATABASE_URL in .env.local point at it? See README.");
  process.exitCode = 1;
} finally {
  await client.end();
}
