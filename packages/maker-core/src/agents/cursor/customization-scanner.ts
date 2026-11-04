import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from "../../types/customizations.js";
import {
  scanCustomizationSources,
  type SourceDef,
} from "../shared/customization-scanner.js";

/** Native local Cursor skill roots; no SDK/account startup is needed for discovery. */
export async function scanCursorCustomizations(
  opts: ListCustomizationsOptions,
): Promise<ListCustomizationsResult> {
  if (opts.kinds?.length && !opts.kinds.includes("skill"))
    return { items: [], errors: [] };
  const sources: SourceDef[] = [];
  const add = (root: string, scope: string, workingDir?: string) => {
    for (const namespace of [".cursor", ".agents"]) {
      sources.push({
        engine: "cursor",
        kind: "skill",
        scope,
        dir: path.join(root, namespace, "skills"),
        ...(workingDir ? { workingDir } : {}),
      });
    }
  };
  // Project entries first: the nearest project definition wins in the slash palette.
  const seen = new Set<string>();
  for (const workingDir of opts.workingDirs ?? []) {
    if (!path.isAbsolute(workingDir)) continue;
    let current = path.resolve(workingDir);
    while (!seen.has(current)) {
      seen.add(current);
      add(current, "project", workingDir);
      if (fs.existsSync(path.join(current, ".git"))) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  add(os.homedir(), "global");
  return scanCustomizationSources(sources);
}
