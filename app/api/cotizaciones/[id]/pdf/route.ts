import { type NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "@/lib/authorization";
import { AppError, safeError } from "@/lib/errors";
import { getQuotationPdf } from "@/lib/quotations/delivery";

export const runtime = "nodejs";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/cotizaciones/[id]/pdf">) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Debes iniciar sesión." }, { status: 401 });
  const { id } = await ctx.params;
  const rev = Number.parseInt(request.nextUrl.searchParams.get("rev") ?? "", 10);
  try {
    const { bytes, fileName } = await getQuotationPdf(principal, id, Number.isInteger(rev) ? rev : undefined);
    return new NextResponse(new Uint8Array(bytes), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    const status = error instanceof AppError ? ({ NOT_FOUND: 404, FORBIDDEN: 403, UNAUTHENTICATED: 401, VALIDATION: 400, CONFLICT: 409, RATE_LIMITED: 429 } as const)[error.code] : 500;
    return NextResponse.json({ error: safeError(error) }, { status });
  }
}
