import { expect, test } from "vitest";
import { claudeUsage } from "../src/claude-history";

/**
 * A resumed session replays earlier messages into its own transcript, so the same message is on disk
 * several times over. Summing without the message id inflates the total, measurably: on a real
 * profile it read sixty percent high.
 */

function line(
  usage: Record<string, unknown>,
  overrides: { id?: string; uuid?: string; model?: string; type?: string } = {},
): string {
  const {
    id = "msg_1",
    uuid = "record-1",
    model = "claude-opus-5",
    type = "assistant",
  } = overrides;
  return JSON.stringify({
    type,
    uuid,
    timestamp: "2026-08-10T09:00:00.000Z",
    message: { id, model, role: "assistant", usage },
  });
}

const USAGE = {
  input_tokens: 1_000,
  output_tokens: 200,
  cache_creation_input_tokens: 300,
  cache_read_input_tokens: 90_000,
};

/** Cache reads run an order of magnitude larger and would measure context size, not work done. */
test("cache reads are left out of the count", () => {
  expect(claudeUsage(line(USAGE))).toEqual({
    at: Date.parse("2026-08-10T09:00:00.000Z"),
    id: "msg_1",
    tokens: 1_500,
  });
});

test("the message id is the key, because the record id repeats nothing", () => {
  const first = claudeUsage(line(USAGE, { uuid: "record-1" }));
  const replayed = claudeUsage(line(USAGE, { uuid: "record-2" }));
  expect(replayed?.id).toBe(first?.id);
});

test("a record without a message id falls back to its own id rather than being merged", () => {
  const parsed = claudeUsage(
    JSON.stringify({
      type: "assistant",
      uuid: "record-9",
      timestamp: "2026-08-10T09:00:00.000Z",
      message: { model: "claude-opus-5", usage: USAGE },
    }),
  );
  expect(parsed?.id).toBe("record-9");
});

/** Claude Code writes its own notices, such as a limit being reached, under this model name. */
test("local notices are not usage", () => {
  expect(claudeUsage(line(USAGE, { model: "<synthetic>" }))).toBeNull();
});

test("only assistant messages carry account usage", () => {
  expect(claudeUsage(line(USAGE, { type: "user" }))).toBeNull();
});

test("a message with nothing billable in it is not a day's activity", () => {
  expect(claudeUsage(line({ cache_read_input_tokens: 5_000 }))).toBeNull();
  expect(claudeUsage(line({ input_tokens: 0, output_tokens: 0 }))).toBeNull();
});

test("counts that could not be real are bounded rather than trusted", () => {
  expect(claudeUsage(line({ input_tokens: 5e12 }))?.tokens).toBe(5_000_000);
  expect(claudeUsage(line({ input_tokens: Number.NaN, output_tokens: 40 }))?.tokens).toBe(40);
});

test("lines that are not JSON, or carry no usage, are skipped", () => {
  expect(claudeUsage('{"usage": broken')).toBeNull();
  expect(claudeUsage(JSON.stringify({ type: "assistant", message: { id: "m" } }))).toBeNull();
  expect(claudeUsage("")).toBeNull();
});
