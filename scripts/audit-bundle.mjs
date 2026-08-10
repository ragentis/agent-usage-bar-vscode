import { readFile } from "node:fs/promises";

// Machine-check the bundle claims readers cannot observe: project-owned inputs, one remote host, no
// shell, and no disk writes. This audits literal shipped text, not values assembled at runtime.

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

// Pin the one literal remote; runtime-assembled targets are outside this text audit.
const ALLOWED_URLS = new Set(["https://api.anthropic.com/api/oauth/usage"]);
const urls = [...new Set(bundle.match(/https?:\/\/[^\s"'`\\]+/g) ?? [])];
const unexpected = urls.filter((url) => !ALLOWED_URLS.has(url));
if (unexpected.length > 0) {
  fail(`Network targets outside the allowlist: ${unexpected.join(", ")}`);
}

// Allowlist readable module members instead of guessing write-like names. Only explicit member
// access can be inspected; default imports are followed and indexed access fails closed.
const READ_ONLY_MEMBERS = {
  fs: ["existsSync", "watch"],
  "fs/promises": ["readFile", "readdir", "stat", "lstat"],
  child_process: ["spawn"],
};

for (const [specifier, allowed] of Object.entries(READ_ONLY_MEMBERS)) {
  const required = new RegExp(String.raw`require\("(?:node:)?${specifier}"\)`);
  if (!required.test(bundle)) {
    continue;
  }

  // Follow the binding assigned by the bundler; fail closed when a require cannot be inspected.
  const bindings = [
    ...bundle.matchAll(
      new RegExp(String.raw`(?:var|let|const)\s+([\w$]+)\s*=\s*[\w$]*\(?${required.source}`, "g"),
    ),
  ].map((match) => match[1]);
  if (bindings.length === 0) {
    fail(`Cannot tell which binding holds ${specifier}; the audit cannot read this bundle`);
  }

  const used = new Set();
  for (const binding of bindings) {
    if (new RegExp(String.raw`\b${binding}(?:\.default)?\s*\[`).test(bundle)) {
      fail(`${specifier} is reached by index, which hides the member from this audit`);
    }
    const member = new RegExp(String.raw`\b${binding}\.(?:default\.)?([\w$]+)`, "g");
    for (const match of bundle.matchAll(member)) {
      used.add(match[1]);
    }
  }

  const writes = [...used].filter((member) => !allowed.includes(member) && member !== "default");
  if (writes.length > 0) {
    fail(`Members of ${specifier} outside the read-only set: ${writes.join(", ")}`);
  }
}

// Module allowlists cannot express spawn options or the Codex credential boundary.
for (const pattern of [/\bshell\s*:\s*true/, /\.codex[\\/]auth\.json/, /\bunlock-keychain\b/]) {
  if (pattern.test(bundle)) {
    fail(`Forbidden pattern in the bundle: ${pattern}`);
  }
}

// Only the read-only keychain verb may ship.
const keychainVerbs = [...new Set(bundle.match(/\b[a-z]+-(?:generic|internet)-password\b/g) ?? [])];
const writeVerbs = keychainVerbs.filter((verb) => verb !== "find-generic-password");
if (writeVerbs.length > 0) {
  fail(`Keychain verbs other than find-generic-password: ${writeVerbs.join(", ")}`);
}

// Pin the keychain tool and system Codex locations; home-relative candidates are assembled at runtime.
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
