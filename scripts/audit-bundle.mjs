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

// Codex is spawned directly so no argument can ever be read as a command, and its stored token is
// none of our business. Nothing is written anywhere: both providers are read-only by design, which
// is a stronger and simpler thing to assert than guarding the credential paths one at a time. The
// macOS sign-in lives in the login keychain, and `find-generic-password` is the only verb that may
// reach it — every verb that would change what is stored there fails the build.
for (const pattern of [
  /\bexecSync\s*\(/,
  /\bexecFileSync\s*\(/,
  /\bshell\s*:\s*true/,
  /\.codex[\\/]auth\.json/,
  /\bwriteFile\b/,
  /\bappendFile\b/,
  /\bcreateWriteStream\b/,
  /\badd-generic-password\b/,
  /\bdelete-generic-password\b/,
  /\bset-generic-password\b/,
  /\bunlock-keychain\b/,
]) {
  if (pattern.test(bundle)) {
    fail(`Forbidden pattern in the bundle: ${pattern}`);
  }
}

// Two programs are started, both of them the user's own tooling, and only one of them by absolute
// path. Pinning every rooted path the bundle carries is what keeps that list from growing quietly.
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
