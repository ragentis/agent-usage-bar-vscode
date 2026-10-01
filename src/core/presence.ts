import * as fs from "node:fs/promises";
import type { ProviderResult } from "../usage";
import { isNotFound } from "../validation";

/**
 * A read that finds nothing to run or read does not prove the agent is missing: an install this
 * extension cannot find fails the same way. The item is hidden only when the agent's data directory
 * is missing too. A directory that cannot be checked counts as present.
 */
export async function confirmAbsence(
  result: ProviderResult,
  directory: string,
  stat: (path: string) => Promise<unknown> = fs.stat,
): Promise<ProviderResult> {
  if (result.status !== "unavailable" || !result.absent) {
    return result;
  }
  try {
    await stat(directory);
  } catch (error) {
    if (isNotFound(error)) {
      return result;
    }
  }
  return { ...result, absent: false };
}
