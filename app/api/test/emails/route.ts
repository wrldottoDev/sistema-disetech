import { getTestOutbox } from "@/lib/email";
import { getServerEnv } from "@/lib/env";

export async function GET() {
  if (process.env.NODE_ENV === "production" || getServerEnv().ENABLE_TEST_ENDPOINTS !== "true") {
    return new Response(null, { status: 404 });
  }
  return Response.json(getTestOutbox(), { headers: { "Cache-Control": "no-store" } });
}
