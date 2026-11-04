import type { ModelListItem, ModelSelection } from "@cursor/sdk";
import type { ModelDescriptor } from "../../types/capabilities.js";
import type { Effort } from "../../types/common.js";

const EFFORTS: readonly Effort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
export interface CursorModelTuning {
  effort?: string;
  fastMode?: boolean | "ultrafast";
  contextWindowBudget?: number | null;
  thinkingEnabled?: boolean;
}

function tokens(value?: string): number {
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(value?.trim() ?? "");
  if (!match) return 0;
  const count =
    Number(match[1]) *
    (match[2]?.toLowerCase() === "m"
      ? 1e6
      : match[2]?.toLowerCase() === "k"
        ? 1e3
        : 1);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function defaults(model: ModelListItem) {
  return model.variants?.find((variant) => variant.isDefault)?.params ?? [];
}

/** Account-reported metadata only. Missing context/pricing is never borrowed from another harness. */
export function cursorModelDescriptor(model: ModelListItem): ModelDescriptor & {
  contextWindowMax?: number;
  contextWindowVerified: boolean;
  thinkingToggle?: boolean;
} {
  const params = model.parameters ?? [];
  const effort = params.find(
    (param) => param.id === "effort" || param.id === "reasoning",
  );
  const efforts = EFFORTS.filter((level) =>
    effort?.values.some((entry) => entry.value === level),
  );
  const defaultEffort = defaults(model).find(
    (param) => param.id === effort?.id,
  )?.value;
  const context = params.find((param) => param.id === "context");
  const contextValues =
    context?.values.map((entry) => tokens(entry.value)).filter(Boolean) ?? [];
  const contextWindow =
    tokens(defaults(model).find((param) => param.id === "context")?.value) ||
    (contextValues.length === 1 ? contextValues[0] : 0);
  return {
    id: model.id,
    displayName: model.displayName,
    description: model.description,
    contextWindow,
    contextWindowVerified: contextWindow > 0,
    ...(contextValues.length
      ? { contextWindowMax: Math.max(...contextValues) }
      : {}),
    efforts,
    defaultEffort: efforts.find((level) => level === defaultEffort) ?? null,
    effortsUnknown: false,
    supportsFastMode: params.some(
      (param) =>
        param.id === "fast" &&
        param.values.some((entry) => entry.value === "true"),
    ),
    supportsImageInput: true,
    thinkingToggle: params.some(
      (param) =>
        param.id === "thinking" &&
        ["true", "false"].every((value) =>
          param.values.some((entry) => entry.value === value),
        ),
    ),
  };
}

export function cursorModelContextWindow(
  selection: ModelSelection,
  definition?: ModelListItem,
): number {
  return (
    tokens(selection.params?.find((param) => param.id === "context")?.value) ||
    (definition ? cursorModelDescriptor(definition).contextWindow : 0)
  );
}

/** Translate Cindy's standard tuning into Cursor's catalog-declared parameter names/values. */
export function cursorModelSelection(
  id: string,
  model: ModelListItem | undefined,
  tuning: CursorModelTuning = {},
): ModelSelection {
  if (tuning.fastMode === "ultrafast")
    throw new Error("Cursor does not support Ultrafast");
  if (!model) return { id };
  const selected = new Map(
    defaults(model).map((param) => [param.id, param.value]),
  );
  for (const param of model.parameters ?? []) {
    let requested: string | undefined;
    if (param.id === "effort" || param.id === "reasoning")
      requested = tuning.effort;
    if (param.id === "fast" && tuning.fastMode !== undefined) {
      requested = String(tuning.fastMode);
    }
    if (param.id === "thinking" && tuning.thinkingEnabled !== undefined)
      requested = String(tuning.thinkingEnabled);
    if (
      param.id === "context" &&
      tuning.contextWindowBudget &&
      tuning.contextWindowBudget > 0
    ) {
      // The host budget can be smaller than a native context tier. Select a supported capacity,
      // never pass arbitrary token counts as invented SDK parameter values.
      const tiers = param.values
        .map((entry) => ({ value: entry.value, tokens: tokens(entry.value) }))
        .filter((entry) => entry.tokens > 0)
        .sort((a, b) => a.tokens - b.tokens);
      requested = (
        tiers.find((entry) => entry.tokens >= tuning.contextWindowBudget!) ??
        tiers.at(-1)
      )?.value;
    }
    if (
      requested !== undefined &&
      param.values.some((entry) => entry.value === requested)
    )
      selected.set(param.id, requested);
  }
  return {
    id,
    ...(selected.size
      ? { params: [...selected].map(([id, value]) => ({ id, value })) }
      : {}),
  };
}
