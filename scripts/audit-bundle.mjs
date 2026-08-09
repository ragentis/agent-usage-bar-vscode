import { readFile } from "node:fs/promises";

// The README makes four promises about an extension that reads an OAuth token: it ships only this
// repository's own code, reaches one host, starts no shell, and writes nothing to disk. Those are
// the claims a reader cannot verify by looking at the status bar, and the ones that decay silently
// as code changes. This script is their machine-checkable form; nothing else belongs here.
//
// It reads the shipped text, so it holds for what the bundle spells out and not for what it could
// assemble at runtime. That is worth stating rather than implying: the point is to catch a change
// that quietly breaks a promise, not to contain an author who means to.

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
// second endpoint fails the build even if it looks harmless. Literal URLs only — a target built
// from parts at runtime is past what reading the text can settle.
const ALLOWED_URLS = new Set(["https://api.anthropic.com/api/oauth/usage"]);
const urls = [...new Set(bundle.match(/https?:\/\/[^\s"'`\\]+/g) ?? [])];
const unexpected = urls.filter((url) => !ALLOWED_URLS.has(url));
if (unexpected.length > 0) {
  fail(`Network targets outside the allowlist: ${unexpected.join(", ")}`);
}

// Whatever the bundle reaches for in these modules has to be a member that reads. Collecting what
// is there beats naming what is not: a denylist of spellings misses `writeFileSync` the moment
// someone writes it that way, and misses every verb nobody thought of.
//
// Members are read off the binding, so only the member-access forms below can be inspected. A
// default import adds one hop, which is handled explicitly. Index access hides the member name from
// this check and therefore fails outright.
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

  // Taking the binding from the require that made it is what lets the bundler name it anything;
  // what would switch the check off is a require this cannot read at all, so that fails outright
  // rather than passing with nothing found.
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

  // `default` survives only where nothing follows it, which is the namespace object itself.
  const writes = [...used].filter((member) => !allowed.includes(member) && member !== "default");
  if (writes.length > 0) {
    fail(`Members of ${specifier} outside the read-only set: ${writes.join(", ")}`);
  }
}

// What the module allowlists cannot say: that `spawn` is never handed a shell, and that the Codex
// credential file is none of our business.
for (const pattern of [/\bshell\s*:\s*true/, /\.codex[\\/]auth\.json/, /\bunlock-keychain\b/]) {
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
