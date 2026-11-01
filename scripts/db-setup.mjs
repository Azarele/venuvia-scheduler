// Creates the tables and loads demo data: `npm run db:setup`.
// Safe to re-run at any time to reset the database to the demo state.
import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgres://venuvia:venuvia@localhost:5432/venuvia";
const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  for (const file of ["db/schema.sql", "db/seed.sql"]) {
    await client.query(await readFile(file, "utf8"));
    console.log(`✓ ran ${file}`);
  }
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
