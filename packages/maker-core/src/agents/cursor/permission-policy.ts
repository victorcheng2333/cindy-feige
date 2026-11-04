import type { PermissionMode } from "../../types/common.js";
import type { CursorOpenOptions } from "./protocol.js";

export function cursorPermissionMode(
  mode: PermissionMode | undefined,
): CursorOpenOptions["permissionMode"] {
  if (mode === "bypassPermissions" || mode === "plan") return mode;
  // Legacy Ask cannot be implemented by the SDK. The adapter emits an explicit notice.
  return "auto";
}

export function cursorRuntimePolicy(
  mode: CursorOpenOptions["permissionMode"],
  planMode = false,
) {
  return {
    mode: planMode || mode === "plan" ? ("plan" as const) : ("agent" as const),
    local: {
      autoReview: mode !== "bypassPermissions",
      sandboxOptions: { enabled: mode !== "bypassPermissions" },
    },
  };
}
