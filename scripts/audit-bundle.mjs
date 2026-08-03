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
// is a stronger and simpler thing to assert than guarding the credential paths one at a time.
for (const pattern of [
  /\bexecSync\s*\(/,
  /\bexecFileSync\s*\(/,
  /\bshell\s*:\s*true/,
  /\.codex[\\/]auth\.json/,
  /\bwriteFile\b/,
  /\bappendFile\b/,
  /\bcreateWriteStream\b/,
]) {
  if (pattern.test(bundle)) {
    fail(`Forbidden pattern in the bundle: ${pattern}`);
  }
}

console.log(`Bundle audit passed: ${inputs.length} inputs, no runtime dependencies.`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
