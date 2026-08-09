import { readFile } from "node:fs/promises";

// The README makes four promises about an extension that reads an OAuth token: it ships only this
// repository's own code, talks to exactly one host, never starts a shell, and never writes to disk.
// Those are the claims a reader cannot verify by looking at the status bar, and the ones that decay
// silently as code changes. This script is their machine-checkable form; nothing else belongs here.

const manifest = JSON.parse(await readFile("package.json", "utf8"));
if (Object.keys(manifest.dependencies ?? {}).length > 0) {
  fail("Runtime dependencies are not allowed");
}

const metafile = JSON.parse(await readFile("dist/meta.json", "utf8"));
const inputs = Object.keys(metafile.inputs);
const foreign = inputs.filter((input) => !input.replaceAll("\\", "/").startsWith("src/"));
if (foreign.length > 0) {
  fail(`Bundle inputs outside src/: ${foreign.join(", ")}`);
}

const bundle = await readFile("dist/extension.js", "utf8");

// One remote, to read the signed-in user's own usage. The list is pinned rather than shaped, so a
// second endpoint fails the build even if it looks harmless.
const ALLOWED_URLS = new Set(["https://api.anthropic.com/api/oauth/usage"]);
const urls = [...new Set(bundle.match(/https?:\/\/[^\s"'`\\]+/g) ?? [])];
const unexpected = urls.filter((url) => !ALLOWED_URLS.has(url));
if (unexpected.length > 0) {
  fail(`Network targets outside the allowlist: ${unexpected.join(", ")}`);
}

// Codex is spawned directly so no argument can be read as a command, its stored token is none of
// our business, and nothing is written anywhere — a stronger claim than guarding each credential
// path in turn.
for (const pattern of [
  /\bexecSync\s*\(/,
  /\bexecFileSync\s*\(/,
  /\bshell\s*:\s*true/,
  /\.codex[\\/]auth\.json/,
  /\bwriteFile\b/,
  /\bappendFile\b/,
  /\bcreateWriteStream\b/,
  /\bunlock-keychain\b/,
]) {
  if (pattern.test(bundle)) {
    fail(`Forbidden pattern in the bundle: ${pattern}`);
  }
}

// The macOS sign-in lives in the login keychain, and only the verb that reads may reach it.
const keychainVerbs = [...new Set(bundle.match(/\b[a-z]+-(?:generic|internet)-password\b/g) ?? [])];
const writeVerbs = keychainVerbs.filter((verb) => verb !== "find-generic-password");
if (writeVerbs.length > 0) {
  fail(`Keychain verbs other than find-generic-password: ${writeVerbs.join(", ")}`);
}

// Three rooted paths belong here: the keychain tool, and the two system locations `codex` may sit
// in. Its other candidates are built from the home directory, so they never reach the bundle as
// literals. Pinning what does is what keeps the list from growing quietly.
const ALLOWED_ROOTED_PATHS = new Set([
  "/usr/bin/security",
  "/usr/local/bin/codex",
  "/opt/homebrew/bin/codex",
]);
const rooted = [
  ...new Set(
    bundle.match(/(?<=["'`])\/(?:usr|opt|bin|sbin|etc|var|private|Library|System)\/[^"'`\s]*/g) ??
      [],
  ),
];
const unpinned = rooted.filter((entry) => !ALLOWED_ROOTED_PATHS.has(entry));
if (unpinned.length > 0) {
  fail(`Absolute paths outside the allowlist: ${unpinned.join(", ")}`);
}

console.log(`Bundle audit passed: ${inputs.length} inputs, no runtime dependencies.`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
