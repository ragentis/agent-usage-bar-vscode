import { rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { forEachTranscriptLine } from "../src/history/transcripts";

/**
 * Real files, because the cases that matter are where the stream cuts the text: a transcript is
 * delivered in chunks whose edges fall inside a line and inside a character.
 */

let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-usage-bar-transcripts-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function lines(since = 0): Promise<string[]> {
  const read: string[] = [];
  await forEachTranscriptLine(root, since, (line) => read.push(line));
  return read;
}

test("a line longer than one chunk arrives whole, with its multi-byte characters intact", async () => {
  const long = JSON.stringify({ text: "é".repeat(200_000) });
  await fs.writeFile(path.join(root, "session.jsonl"), `{"a":1}\n${long}\n{"b":2}\n`, "utf8");

  expect(await lines()).toEqual(['{"a":1}', long, '{"b":2}']);
});

test("a last line still being written is handed over, and empty lines are not", async () => {
  await fs.writeFile(path.join(root, "session.jsonl"), '{"a":1}\n\n{"b":2}', "utf8");

  expect(await lines()).toEqual(['{"a":1}', '{"b":2}']);
});

test("only a line feed ends a line, since a JSON string may hold the other separators", async () => {
  const separators = '{"text":"one two three\rfour"}';
  await fs.writeFile(path.join(root, "session.jsonl"), `${separators}\n`, "utf8");

  expect(await lines()).toEqual([separators]);
});

test("a file removed after it was listed is passed over without ending the scan", async () => {
  const names = ["a", "b", "c"];
  await Promise.all(
    names.map((name) => fs.writeFile(path.join(root, `${name}.jsonl`), `${name}\n`, "utf8")),
  );

  // Directory order differs by filesystem, so the file to remove is chosen once the first is read.
  const read: string[] = [];
  let removed = "";
  await forEachTranscriptLine(root, 0, (line) => {
    read.push(line);
    if (!removed) {
      removed = names.find((name) => name !== line) ?? "";
      rmSync(path.join(root, `${removed}.jsonl`));
    }
  });

  expect(read).toHaveLength(2);
  expect(read).not.toContain(removed);
});

test("a file last written before the scan's start is not opened", async () => {
  const stale = path.join(root, "stale.jsonl");
  await fs.writeFile(stale, '{"old":1}\n', "utf8");
  await fs.utimes(stale, new Date(1_000), new Date(1_000));
  await fs.writeFile(path.join(root, "fresh.jsonl"), '{"new":1}\n', "utf8");

  expect(await lines(2_000)).toEqual(['{"new":1}']);
});
