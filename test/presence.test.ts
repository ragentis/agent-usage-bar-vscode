import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { confirmAbsence } from "../src/presence";
import type { ProviderResult } from "../src/usage";

let home = "";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-usage-bar-presence-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const NOTHING_TO_RUN: ProviderResult = {
  status: "unavailable",
  message: "The Codex CLI could not be started. Check that Codex is installed.",
  absent: true,
};

test("an agent with nothing to run and no data directory is absent", async () => {
  await expect(confirmAbsence(NOTHING_TO_RUN, path.join(home, ".codex"))).resolves.toEqual(
    NOTHING_TO_RUN,
  );
});

test("an agent that left a data directory keeps its item, whatever the read found", async () => {
  await fs.mkdir(path.join(home, ".codex"));

  await expect(confirmAbsence(NOTHING_TO_RUN, path.join(home, ".codex"))).resolves.toEqual({
    ...NOTHING_TO_RUN,
    absent: false,
  });
});

test("a directory that cannot be looked at is not taken as missing", async () => {
  const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

  const result = await confirmAbsence(NOTHING_TO_RUN, path.join(home, ".codex"), () =>
    Promise.reject(denied),
  );

  expect(result).toMatchObject({ absent: false });
});

test("only a read that found nothing is ever checked", async () => {
  const signedOut: ProviderResult = { status: "unavailable", message: "Sign in to Codex." };
  const reading: ProviderResult = {
    status: "ok",
    snapshot: {
      windows: [{ kind: "session", usedPercent: 5, resetsAt: null }],
      plan: null,
      blocked: null,
      credits: null,
      fetchedAt: new Date(),
      source: "codex-app-server",
    },
  };

  await expect(confirmAbsence(signedOut, path.join(home, ".codex"))).resolves.toBe(signedOut);
  await expect(confirmAbsence(reading, path.join(home, ".codex"))).resolves.toBe(reading);
});
