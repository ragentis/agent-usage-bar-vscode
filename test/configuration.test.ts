import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  configurationEffect,
  DEFAULT_ERROR_THRESHOLD,
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  DEFAULT_WARNING_THRESHOLD,
  MAX_REFRESH_INTERVAL_SECONDS,
  MIN_REFRESH_INTERVAL_SECONDS,
  resolveConfiguration,
  type ExtensionConfiguration,
} from "../src/configuration";
import { isRecord } from "../src/usage";

function configure(overrides: Partial<ExtensionConfiguration> = {}): ExtensionConfiguration {
  return {
    displayMode: "compact",
    percentageMode: "used",
    showPace: true,
    warningThreshold: 80,
    errorThreshold: 95,
    codexEnabled: true,
    claudeEnabled: false,
    claudeLabel: "",
    codexLabel: "",
    refreshIntervalSeconds: 300,
    ...overrides,
  };
}

test("only source settings trigger a provider read", () => {
  expect(configurationEffect(configure(), configure())).toBe("none");
  expect(configurationEffect(configure(), configure({ warningThreshold: 50 }))).toBe("redraw");
  expect(configurationEffect(configure(), configure({ displayMode: "full" }))).toBe("redraw");
  // The pace is drawn from the reading already in hand, so switching it on asks no provider.
  expect(configurationEffect(configure(), configure({ showPace: false }))).toBe("redraw");
  expect(configurationEffect(configure(), configure({ claudeEnabled: true }))).toBe("refresh");
  // A relabelled item is repainted, never re-read.
  expect(configurationEffect(configure(), configure({ codexLabel: "CX" }))).toBe("redraw");
  // A new interval is consulted at the next tick; there is no timer left for it to restart.
  expect(configurationEffect(configure(), configure({ refreshIntervalSeconds: 60 }))).toBe("none");
});

/**
 * The manifest cannot be generated and the code cannot read it at runtime, so the bounds exist
 * twice over. Drifting apart is silent in both directions: the settings UI would offer a value the
 * code clamps away, or clamp one the code would have taken.
 */
test("the manifest states the same settings bounds the code enforces", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as unknown;
  const at = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : null);
  const property = (key: string): unknown =>
    at(at(at(at(manifest, "contributes"), "configuration"), "properties"), `agentUsageBar.${key}`);

  expect(property("refreshIntervalSeconds")).toMatchObject({
    default: DEFAULT_REFRESH_INTERVAL_SECONDS,
    minimum: MIN_REFRESH_INTERVAL_SECONDS,
    maximum: MAX_REFRESH_INTERVAL_SECONDS,
  });
  expect(property("warningThreshold")).toMatchObject({
    default: DEFAULT_WARNING_THRESHOLD,
    minimum: 0,
    maximum: 100,
  });
  expect(property("errorThreshold")).toMatchObject({
    default: DEFAULT_ERROR_THRESHOLD,
    minimum: 0,
    maximum: 100,
  });
});

/**
 * The settings UI enforces the manifest's bounds, and nothing else does: a value typed into
 * `settings.json` by hand arrives here exactly as written, as does one left behind by a version
 * whose bounds were different. What `resolveConfiguration` hands back is what the rest of the
 * extension treats as already checked, so every way a stored value can be wrong is answered here.
 */

/** Settings as they are stored, read the way the host reads them: a key, and a default. */
function stored(values: Record<string, unknown> = {}): ExtensionConfiguration {
  return resolveConfiguration(<T>(key: string, fallback: T): T =>
    // The assertion is the seam itself: `get<T>` hands back whatever JSON is on disk under the type
    // that was asked for, checking nothing. Values that do not match are the point of these tests.
    // oxlint-disable-next-line no-unsafe-type-assertion -- modelling what the host actually does
    key in values ? (values[key] as T) : fallback,
  );
}

test("an unset section is the manifest's defaults, whole", () => {
  expect(stored()).toEqual({
    displayMode: "compact",
    percentageMode: "used",
    showPace: true,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
    errorThreshold: DEFAULT_ERROR_THRESHOLD,
    codexEnabled: true,
    claudeEnabled: true,
    codexLabel: "",
    claudeLabel: "",
    refreshIntervalSeconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
  });
});

test("a threshold outside the manifest's range is pulled back into it", () => {
  expect(stored({ warningThreshold: 140 }).warningThreshold).toBe(100);
  expect(stored({ warningThreshold: -20 }).warningThreshold).toBe(0);
  // Not a number at all, which is what a hand-edited file or an older shape can hold.
  expect(stored({ warningThreshold: Number.NaN }).warningThreshold).toBe(DEFAULT_WARNING_THRESHOLD);
  expect(stored({ refreshIntervalSeconds: 5 }).refreshIntervalSeconds).toBe(
    MIN_REFRESH_INTERVAL_SECONDS,
  );
  expect(stored({ refreshIntervalSeconds: 86_400 }).refreshIntervalSeconds).toBe(
    MAX_REFRESH_INTERVAL_SECONDS,
  );
});

test("the error background never appears before the warning one, however the two were set", () => {
  // Both are in range and each is valid alone, so nothing but this rule catches the pair. The
  // manifest states it in prose to the user; here it is the only place it is enforced.
  expect(stored({ warningThreshold: 90, errorThreshold: 50 }).errorThreshold).toBe(90);
  // Raised past its own ceiling first, the warning threshold still carries the error one with it.
  expect(stored({ warningThreshold: 200, errorThreshold: 50 }).errorThreshold).toBe(100);
  // An order that already holds is left exactly as it was written.
  expect(stored({ warningThreshold: 60, errorThreshold: 75 }).errorThreshold).toBe(75);
});

test("a label is trimmed to something that cannot push the item off the bar", () => {
  expect(stored({ "claude.label": "  CC  " }).claudeLabel).toBe("CC");
  // A newline in the text of a status bar item breaks the item, not the line.
  expect(stored({ "codex.label": "one\ntwo\t three" }).codexLabel).toBe("one two three");
  expect(stored({ "claude.label": "x".repeat(400) }).claudeLabel).toHaveLength(24);
  // Anything that is not text at all reads as no label, which is the icon.
  expect(stored({ "codex.label": 42 }).codexLabel).toBe("");
  expect(stored({ "claude.label": null }).claudeLabel).toBe("");
});
