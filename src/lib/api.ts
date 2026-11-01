import { ProviderError } from "./ai/providers.ts";
import { BookingError } from "./bookings.ts";

/** Turns errors into JSON the UI can show. Unexpected errors are logged and kept vague. */
export function errorResponse(error: unknown): Response {
  if (error instanceof BookingError || error instanceof ProviderError)
    return Response.json({ error: error.message }, { status: error instanceof BookingError ? 400 : 502 });
  const code = (error as { code?: string }).code;
  if (code === "ECONNREFUSED" || code === "3D000" || code === "28P01" || code === "42P01")
    return Response.json(
      { error: `Can't use the database (${code}). Is Postgres running and did you run "npm run db:setup"? Check DATABASE_URL in .env.local.` },
      { status: 503 },
    );
  console.error(error);
  return Response.json({ error: "Something went wrong on the server. Check the terminal for details." }, { status: 500 });
}
