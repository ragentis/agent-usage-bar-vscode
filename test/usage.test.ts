import { expect, test } from "vitest";
import { mergeView, validLabel, type ProviderView, type UsageSnapshot } from "../src/usage";

const snapshot: UsageSnapshot = {
  windows: [{ kind: "session", usedPercent: 12, resetsAt: null }],
  plan: "plus",
  blocked: null,
  credits: null,
  fetchedAt: new Date("2026-08-01T10:00:00Z"),
  source: "claude-account-api",
};

const held: ProviderView = { snapshot, message: null };

test("a reading replaces what came before it, message and all", () => {
  const newer = { ...snapshot, fetchedAt: new Date("2026-08-01T10:05:00Z") };
  expect(
    mergeView({ snapshot, message: "stale complaint" }, { snapshot: newer, message: null }),
  ).toEqual({ snapshot: newer, message: null });
});

test("a message arriving without a reading never blanks the one on screen", () => {
  expect(mergeView(held, { snapshot: null, message: "could not be reached" })).toEqual({
    snapshot,
    message: "could not be reached",
  });
});

test("with nothing held, a message is all there is to show", () => {
  expect(mergeView(undefined, { snapshot: null, message: "no sign-in was found" })).toEqual({
    snapshot: null,
    message: "no sign-in was found",
  });
});

test("a label longer than a tooltip line can carry is not a label", () => {
  expect(validLabel("x".repeat(80))).toHaveLength(80);
  expect(validLabel("x".repeat(81))).toBeNull();
  expect(validLabel(`  ${"x".repeat(80)}  `)).toHaveLength(80);
});

test("only a string with something in it is a label", () => {
  expect(validLabel("  max  ")).toBe("max");
  expect(validLabel("")).toBeNull();
  expect(validLabel("   ")).toBeNull();
  expect(validLabel(null)).toBeNull();
  expect(validLabel(42)).toBeNull();
  expect(validLabel({ toString: () => "max" })).toBeNull();
});
