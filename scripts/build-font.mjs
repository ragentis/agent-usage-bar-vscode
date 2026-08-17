import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

// Regenerate the day glyphs in the Fontello configuration and rebuild the icon font from it. The
// provider marks are hand-drawn and are carried through untouched; only the bars are generated here,
// because their whole purpose is a set of exact heights that a drawing tool cannot hold by hand.
//
// Run with `npm run font` after changing any number below. The font is a committed asset, so this is
// a maintenance step and never part of a build.

const CONFIG_PATH = "assets/fontello-config.json";
const MANIFEST_PATH = "package.json";
const FONT_NAME = "agent-usage-bar";
const FONT_PATH = `assets/${FONT_NAME}.woff`;
const FONTELLO = "https://fontello.com";

/** Fontello reads SVG coordinates and writes `ascent - y`, so this row is the baseline. */
const ASCENT = 970;

/**
 * One glyph is one day. The advance width carries the gap to the next day, so a row of them needs no
 * spacing of its own, and thirty of them reach the width the usage bars occupy.
 *
 * The bars are 314 space cells shrunk by six `<small>` elements, so matching them means knowing how
 * wide a space is in the theme's UI font. That was first assumed and came out a fifth short; the
 * advance is measured instead, against a rendered tooltip. Ink and radius are scaled with it, so the
 * shape of a day and the gap beside it stay in the proportion they were drawn in.
 */
const ADVANCE = 959;

const INK = 702;

const RADIUS = 129;

/**
 * The floor mark for a day with no activity, then the five steps. A step is not proportional to the
 * day it stands for: the shortest must stay visible, so the ramp starts well above nothing.
 *
 * The tallest stands well above the 970 the font calls its ascent, so it rises past the line box and
 * towards the title. That is deliberate and it is also the ceiling: taller than this and a busy day
 * starts touching the text above it.
 */
const HEIGHTS = [263, 527, 747, 965, 1185, 1404];

/**
 * Steps are named, never numbered. VS Code registers an icon whose id contains a digit, and draws
 * its CSS rule, but the Markdown sanitizer keeps a codicon class only when it matches
 * `/^codicon codicon-[a-z-]+( codicon-modifier-[a-z-]+)?$/`. A digit fails that, the class is
 * stripped, and the glyph renders as an empty element with nothing reported anywhere.
 */
const STEPS = ["none", "one", "two", "three", "four", "five"];

const KAPPA = 0.5522847498307936;

function round(value) {
  return Number(value.toFixed(1));
}

/**
 * A bar standing on the baseline, rounded on all four corners. Corners are cubic curves rather than
 * arcs because every consumer of this path renders those identically.
 */
function barPath(height) {
  const radius = Math.min(RADIUS, INK / 2, height / 2);
  const pull = radius * KAPPA;
  const left = (ADVANCE - INK) / 2;
  const right = left + INK;
  const bottom = ASCENT;
  const top = ASCENT - height;
  const at = (x, y) => `${round(x)} ${round(y)}`;
  return [
    `M${at(left + radius, top)}`,
    `L${at(right - radius, top)}`,
    `C${at(right - radius + pull, top)} ${at(right, top + radius - pull)} ${at(right, top + radius)}`,
    `L${at(right, bottom - radius)}`,
    `C${at(right, bottom - radius + pull)} ${at(right - radius + pull, bottom)} ${at(right - radius, bottom)}`,
    `L${at(left + radius, bottom)}`,
    `C${at(left + radius - pull, bottom)} ${at(left, bottom - radius + pull)} ${at(left, bottom - radius)}`,
    `L${at(left, top + radius)}`,
    `C${at(left, top + radius - pull)} ${at(left + radius - pull, top)} ${at(left + radius, top)}`,
    "Z",
  ].join("");
}

/** Fontello identifies a glyph by uid, so deriving it from the name keeps re-runs stable. */
function uid(name) {
  return createHash("sha256").update(name).digest("hex").slice(0, 32);
}

function dayGlyphs() {
  return HEIGHTS.map((height, level) => {
    const css = `day-${STEPS[level]}`;
    return {
      uid: uid(css),
      css,
      code: 0xe810 + level,
      src: "custom_icons",
      selected: true,
      svg: { path: barPath(height), width: ADVANCE },
      search: [css],
    };
  });
}

/** Generated with the glyphs so the id, the code point and the height cannot drift apart. */
function dayIcons(fontPath) {
  return Object.fromEntries(
    STEPS.map((step, level) => [
      `${FONT_NAME}-day-${step}`,
      {
        description:
          level === 0
            ? "Daily activity bar, a day with no activity"
            : `Daily activity bar, step ${level} of ${STEPS.length - 1}`,
        default: { fontPath, fontCharacter: `\\E81${level}` },
      },
    ]),
  );
}

/** Reads one file out of a zip. Only the two methods Fontello returns are handled. */
function unzip(archive, wanted) {
  for (let at = archive.length - 22; at >= 0; at--) {
    if (archive.readUInt32LE(at) !== 0x06054b50) {
      continue;
    }
    let entry = archive.readUInt32LE(at + 16);
    for (let index = archive.readUInt16LE(at + 10); index > 0; index--) {
      const nameLength = archive.readUInt16LE(entry + 28);
      const name = archive.toString("utf8", entry + 46, entry + 46 + nameLength);
      const offset = archive.readUInt32LE(entry + 42);
      if (name.endsWith(wanted)) {
        const method = archive.readUInt16LE(offset + 8);
        const size = archive.readUInt32LE(offset + 18);
        const start =
          offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
        const body = archive.subarray(start, start + size);
        return method === 0 ? body : inflateRawSync(body);
      }
      entry +=
        46 + nameLength + archive.readUInt16LE(entry + 30) + archive.readUInt16LE(entry + 32);
    }
  }
  throw new Error(`The Fontello archive has no ${wanted}`);
}

async function build(config) {
  const form = new FormData();
  form.append("config", new Blob([JSON.stringify(config)]), "config.json");
  const session = await fetch(FONTELLO, { method: "POST", body: form });
  if (!session.ok) {
    throw new Error(`Fontello refused the configuration: ${session.status}`);
  }
  const id = (await session.text()).trim();
  if (!/^[0-9a-f]+$/.test(id)) {
    throw new Error(`Fontello answered with something other than a session: ${id.slice(0, 80)}`);
  }
  const archive = await fetch(`${FONTELLO}/${id}/get`);
  if (!archive.ok) {
    throw new Error(`Fontello would not return the font: ${archive.status}`);
  }
  return unzip(Buffer.from(await archive.arrayBuffer()), `${config.name}.woff`);
}

/** The provider marks keep their manifest entries; only the day icons are regenerated. */
async function publish(font) {
  await writeFile(FONT_PATH, font);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const marks = Object.entries(manifest.contributes.icons).filter(
    ([id]) => !id.startsWith(`${FONT_NAME}-day-`),
  );
  manifest.contributes.icons = { ...Object.fromEntries(marks), ...dayIcons(`./${FONT_PATH}`) };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const marks = config.glyphs.filter((glyph) => !glyph.css.startsWith("day-"));
config.glyphs = [...marks, ...dayGlyphs()];

const font = await build(config);
await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
await publish(font);

console.log(
  `Rebuilt ${FONT_PATH}: ${marks.length} provider marks, ${HEIGHTS.length} day glyphs, ${font.length} bytes.`,
);
