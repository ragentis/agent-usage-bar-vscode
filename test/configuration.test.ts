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
    locale: undefined,
    showPace: true,
    warningThreshold: 80,
    errorThreshold: 95,
    warnWhen: "threshold",
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
  expect(configurationEffect(configure(), configure({ showPace: false }))).toBe("redraw");
  expect(configurationEffect(configure(), configure({ warnWhen: "overPace" }))).toBe("redraw");
  expect(configurationEffect(configure(), configure({ claudeEnabled: true }))).toBe("refresh");
  expect(configurationEffect(configure(), configure({ codexLabel: "CX" }))).toBe("redraw");
  expect(configurationEffect(configure(), configure({ locale: "de-DE" }))).toBe("redraw");
  expect(configurationEffect(configure(), configure({ refreshIntervalSeconds: 60 }))).toBe("none");
});

/**
 * Manifest and runtime bounds are separate declarations; this catches silent drift between them.
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
  expect(property("warnWhen")).toMatchObject({
    default: "threshold",
    enum: ["threshold", "overPace"],
  });
});

/**
 * Hand-edited or legacy settings bypass manifest validation, so runtime resolution must bound them.
 */

function stored(values: Record<string, unknown> = {}): ExtensionConfiguration {
  return resolveConfiguration(<T>(key: string, fallback: T): T =>
    // oxlint-disable-next-line no-unsafe-type-assertion -- modelling what the host actually does
    key in values ? (values[key] as T) : fallback,
  );
}

test("an unset section is the manifest's defaults, whole", () => {
  expect(stored()).toEqual({
    displayMode: "compact",
    percentageMode: "used",
    locale: undefined,
    showPace: true,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
    errorThreshold: DEFAULT_ERROR_THRESHOLD,
    warnWhen: "threshold",
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
  expect(stored({ warningThreshold: Number.NaN }).warningThreshold).toBe(DEFAULT_WARNING_THRESHOLD);
  expect(stored({ refreshIntervalSeconds: 5 }).refreshIntervalSeconds).toBe(
    MIN_REFRESH_INTERVAL_SECONDS,
  );
  expect(stored({ refreshIntervalSeconds: 86_400 }).refreshIntervalSeconds).toBe(
    MAX_REFRESH_INTERVAL_SECONDS,
  );
});

test("the error background never appears before the warning one, however the two were set", () => {
  expect(stored({ warningThreshold: 90, errorThreshold: 50 }).errorThreshold).toBe(90);
  expect(stored({ warningThreshold: 200, errorThreshold: 50 }).errorThreshold).toBe(100);
  expect(stored({ warningThreshold: 60, errorThreshold: 75 }).errorThreshold).toBe(75);
});

test("a label is trimmed to something that cannot push the item off the bar", () => {
  expect(stored({ "claude.label": "  CC  " }).claudeLabel).toBe("CC");
  expect(stored({ "codex.label": "one\ntwo\t three" }).codexLabel).toBe("one two three");
  expect(stored({ "claude.label": "x".repeat(400) }).claudeLabel).toHaveLength(24);
  expect(stored({ "codex.label": 42 }).codexLabel).toBe("");
  expect(stored({ "claude.label": null }).claudeLabel).toBe("");
});

test("a locale is either one the runtime can format with or none at all", () => {
  expect(stored({ locale: "en-GB" }).locale).toBe("en-GB");
  expect(stored({ locale: "EN-gb" }).locale).toBe("en-GB");
  expect(stored({ locale: "  de-DE  " }).locale).toBe("de-DE");
  expect(stored({ locale: "en-US-u-hc-h23" }).locale).toBe("en-US-u-hc-h23");
  expect(stored().locale).toBeUndefined();
  expect(stored({ locale: "" }).locale).toBeUndefined();
  expect(stored({ locale: "d.M.yyyy. HH:mm" }).locale).toBeUndefined();
  expect(stored({ locale: "en_US" }).locale).toBeUndefined();
  expect(stored({ locale: "xx-YY" }).locale).toBeUndefined();
  expect(stored({ locale: 42 }).locale).toBeUndefined();
});
