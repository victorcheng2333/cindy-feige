import { redactSensitiveText } from "@cindy/maker-shared/error-redaction";
import type { CursorFailure } from "./protocol.js";

export function cursorFailure(error: unknown): CursorFailure {
  const obj =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  return {
    message: redactSensitiveText(
      typeof obj.message === "string" ? obj.message : "Cursor runtime failed",
    ),
    ...(typeof obj.code === "string" ? { code: obj.code } : {}),
    ...(typeof obj.status === "number" ? { status: obj.status } : {}),
  };
}
export function cursorErrorReason(error: CursorFailure): string {
  if (
    error.status === 429 ||
    /^(?:resource_exhausted|rate_limited(?:_changeable)?|\w*_usage_limit|\w*_rate_limit(?:_exceeded)?)$/i.test(
      error.code ?? "",
    )
  )
    return "usage_limit";
  if (
    error.status === 401 ||
    /unauthenticated|authentication/i.test(error.code ?? "")
  )
    return "auth";
  if (/plan_required/i.test(error.code ?? "")) return "plan_required";
  if (/Cannot use this model:/i.test(error.message)) return "model_unavailable";
  return "cursor_runtime_error";
}
