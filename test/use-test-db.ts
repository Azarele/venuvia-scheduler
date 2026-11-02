// Imported first by the tests: switches to the venuvia_test database before any
// app module opens a connection, so `npm test` never touches your dev data.
import { useIsolatedDatabase } from "../scripts/isolated-db.ts";

await useIsolatedDatabase("test");
