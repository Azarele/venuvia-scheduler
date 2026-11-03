import { ProviderError } from "./ai/providers.ts";
import { BookingError } from "./bookings.ts";

/** Maps an error to a message the UI can show and an HTTP status. Unexpected errors are logged and kept vague. */
export function describeError(error: unknown): { message: string; status: number } {
  if (error instanceof BookingError) return { message: error.message, status: 400 };
  if (error instanceof ProviderError) return { message: error.message, status: 502 };
  const code = (error as { code?: string }).code;
  if (code === "ECONNREFUSED" || code === "3D000" || code === "28P01" || code === "42P01")
    return {
      message: `Can't use the database (${code}). Is Postgres running and did you run "npm run db:setup"? Check DATABASE_URL in .env.local.`,
      status: 503,
    };
  console.error(error);
  return { message: "Something went wrong on the server. Check the terminal for details.", status: 500 };
}

export function errorResponse(error: unknown): Response {
  const { message, status } = describeError(error);
  return Response.json({ error: message }, { status });
}
