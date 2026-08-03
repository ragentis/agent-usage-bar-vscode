import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build, context } from "esbuild";

// The app server is told which client is calling. Reading the version here is what keeps that
// answer true after a release, instead of a second copy nobody remembers to bump.
const { version } = JSON.parse(await readFile("package.json", "utf8"));

// `--dev` keeps source maps so breakpoints work in the Extension Development Host.
const dev = process.argv.includes("--dev");
// `--watch` rebuilds on save, so reloading the host window is enough to pick a change up.
const watch = process.argv.includes("--watch");

await mkdir("dist", { recursive: true });

const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  define: { __EXTENSION_VERSION__: JSON.stringify(version) },
  // Unminified on purpose: the shipped file stays readable, and `audit:bundle` reads it as text.
  minify: false,
  sourcemap: dev || watch,
  metafile: true,
  logLevel: "info",
};

// The metafile lists every input that made it into the bundle, which is what `audit:bundle` checks.
const writeMetafile = (result) =>
  writeFile("dist/meta.json", `${JSON.stringify(result.metafile, null, 2)}\n`, "utf8");

/**
 * esbuild reports failures on its own, but a watch build reports them into a terminal nobody is
 * looking at. This prints one line per problem in the shape the task's matcher expects, so they
 * land in the Problems panel, and brackets each run so VS Code knows when a rebuild is in flight.
 */
const problemMatcherPlugin = {
  name: "problem-matcher",
  setup: (esbuild) => {
    esbuild.onStart(() => console.log("[build] started"));
    esbuild.onEnd((result) => {
      const report =
        (severity) =>
        ({ text, location }) => {
          const where = location
            ? `${location.file}:${location.line}:${location.column}`
            : "unknown:1:1";
          console.log(`${where}: ${severity}: ${text}`);
        };
      result.errors.forEach(report("error"));
      result.warnings.forEach(report("warning"));
      console.log("[build] finished");
    });
  },
};

if (watch) {
  const builder = await context({
    ...options,
    plugins: [
      {
        name: "write-metafile",
        setup: (esbuild) => {
          esbuild.onEnd(async (result) => {
            if (result.metafile) {
              await writeMetafile(result);
            }
          });
        },
      },
      problemMatcherPlugin,
    ],
  });
  await builder.watch();
  console.log("Watching src/ for changes. Reload the Extension Development Host to apply them.");
} else {
  await writeMetafile(await build(options));
}
