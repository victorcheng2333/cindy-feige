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
  const plan = planMode || mode === "plan";
  // Local SDK runs deny, instead of asking about, every call Auto-review or the sandbox
  // escalates, so Auto would block explicit requests such as a push. Only read-only plan
  // runs keep them.
  const guarded = plan && mode !== "bypassPermissions";
  return {
    mode: plan ? ("plan" as const) : ("agent" as const),
    local: {
      autoReview: guarded,
      sandboxOptions: { enabled: guarded },
    },
  };
}
