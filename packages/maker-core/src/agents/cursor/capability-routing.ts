import type {
  CapabilityRouteOverride,
  CapabilityRoutingPolicy,
} from "../../types/capability-routing.js";

/** Only native tool denial has an SDK enforcement point in this adapter. */
export function isCursorCapabilityRouteEnforced(
  route: CapabilityRouteOverride,
): boolean {
  return (
    route.source.harness === "cursor" &&
    route.source.kind === "harness-builtin" &&
    route.source.surface === "tool" &&
    route.invocation === "disabled"
  );
}
export function cursorDisallowedTools(
  policy?: CapabilityRoutingPolicy,
): string[] {
  const routes =
    policy?.overrides.filter((route) => route.source.harness === "cursor") ??
    [];
  if (routes.some((route) => !isCursorCapabilityRouteEnforced(route)))
    throw new Error("Unsupported Cursor capability route");
  return [...new Set(routes.map((route) => route.source.id))];
}
