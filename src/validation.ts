/** Checks for values from outside the extension: provider replies, stored state, and files. */

const MAX_LABEL_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 500;
const MAX_WINDOW_MINUTES = 31 * 24 * 60;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How Node reports a program or path that does not exist. */
export function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function validMillis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function validUsedPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

export function validWindowMinutes(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_WINDOW_MINUTES
    ? value
    : null;
}

export function validDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function validLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_LABEL_LENGTH ? trimmed : null;
}

export function validMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_MESSAGE_LENGTH) : null;
}
