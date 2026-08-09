// Both the version and the changelog are read out of commit subjects, so one that does not parse is
// silent: no changelog entry, no bump, no complaint. This is that shape, in one copy, run by the
// `commit-msg` hook before a commit exists, by pr-title.yml on the pull request title that a squash
// merge turns into the subject, and by CI on the subjects a push adds to `main`.
//
// Subjects arrive as arguments, or one per line on standard input.

import { readFile } from "node:fs/promises";

// The types come from `release-please-config.json`, which is what acts on them, because the two
// drifting apart is the failure this check exists to prevent: a type known here and not to Release
// Please parses, bumps nothing, and never reaches the changelog. Resolved against this file, so the
// working directory cannot matter.
const config = JSON.parse(
  await readFile(new URL("../release-please-config.json", import.meta.url), "utf8"),
);
const types = config["changelog-sections"].map((section) => section.type);

const SUBJECT = new RegExp(String.raw`^(${types.join("|")})(\([a-z0-9./-]+\))?!?: .+`);

// A blank line is what splitting the input leaves behind and means nothing; a blank argument is a
// subject that is empty, which is refused like any other that does not parse.
const subjects =
  process.argv.length > 2
    ? process.argv.slice(2)
    : (await readLines()).filter((line) => line.trim().length > 0);

const rejected = subjects.filter((subject) => !SUBJECT.test(subject.trim()));

if (rejected.length > 0) {
  for (const subject of rejected) {
    console.error(`Not a conventional subject: ${subject || "(empty)"}`);
  }
  console.error("See .github/commit-instructions.md for the types and the shape.");
  process.exit(1);
}

async function readLines() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input.split("\n");
}
