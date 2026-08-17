import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

// Regenerate the day glyphs and the weekly mark in the Fontello configuration and rebuild the icon
// font from it. The provider marks are hand-drawn and are carried through untouched; only the bars
// and the mark are generated here, because their whole purpose is a set of exact sizes that a drawing
// tool cannot hold by hand.
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

/**
 * The elapsed-time mark on a weekly bar. The hover draws a codicon at the surrounding font size and
 * aligns it `middle`, so this glyph is set in the same four-pixel type as the bar's cells and one em
 * here is one em of the cell. A cell is a space of the UI font, 274 units in Segoe UI, and the mark
 * replaces three of them. Middle alignment puts the glyph baseline about a pixel under the text
 * baseline, which the reach above and below already allows for; both are calibrated in a rendered
 * tooltip, like the day advance above. The ink is centred on the advance and may reach past it.
 */
const MARK = {
  cells: 3,
  advance: 822,
  ink: 690,
  radius: 345,
  above: 1400,
  below: 605,
};

/**
 * A halo drawn under the mark, in the hover's own background color, to cut it out of whatever it
 * stands on. It is set before the mark with an advance of a single unit, so the mark's glyph
 * lands on top of it, and its ink reaches this far past the mark's on every side. Both are centred
 * on the mark's advance, so the halo's path starts left of its origin.
 */
const HALO = 345;

/** The glyphs this script generates; the provider marks are hand-drawn and carried through. */
function generated(css) {
  return css.startsWith("day-") || css.startsWith("mark");
}

const KAPPA = 0.5522847498307936;

function round(value) {
  return Number(value.toFixed(1));
}

/**
 * A rectangle rounded on all four corners. Corners are cubic curves rather than arcs because every
 * consumer of this path renders those identically.
 */
function roundedRect(left, right, top, bottom, radius) {
  const pull = radius * KAPPA;
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

/** A bar standing on the baseline. */
function barPath(height) {
  const left = (ADVANCE - INK) / 2;
  const radius = Math.min(RADIUS, INK / 2, height / 2);
  return roundedRect(left, left + INK, ASCENT - height, ASCENT, radius);
}

/** The mark straddles the baseline, so it is placed by its reach above and below it. */
function markPath(halo = 0) {
  const left = (MARK.advance - MARK.ink) / 2 - halo;
  const radius = Math.min(MARK.radius, MARK.ink / 2, (MARK.above + MARK.below) / 2) + halo;
  return roundedRect(
    left,
    left + MARK.ink + 2 * halo,
    ASCENT - MARK.above - halo,
    ASCENT + MARK.below + halo,
    radius,
  );
}

/** Fontello identifies a glyph by uid, so deriving it from the name keeps re-runs stable. */
function uid(name) {
  return createHash("sha256").update(name).digest("hex").slice(0, 32);
}

function markGlyphs() {
  return [
    ["mark", 0xe816, markPath(), MARK.advance],
    ["mark-halo", 0xe817, markPath(HALO), 1],
  ].map(([css, code, path, width]) => ({
    uid: uid(css),
    css,
    code,
    src: "custom_icons",
    selected: true,
    svg: { path, width },
    search: [css],
  }));
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
function generatedIcons(fontPath) {
  return {
    ...Object.fromEntries(
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
    ),
    [`${FONT_NAME}-mark`]: {
      description: "Elapsed-time mark on a weekly usage bar",
      default: { fontPath, fontCharacter: "\\E816" },
    },
    [`${FONT_NAME}-mark-halo`]: {
      description: "Halo drawn under the elapsed-time mark",
      default: { fontPath, fontCharacter: "\\E817" },
    },
  };
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

/** The provider marks keep their manifest entries; only the generated icons are rewritten. */
async function publish(font) {
  await writeFile(FONT_PATH, font);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const marks = Object.entries(manifest.contributes.icons).filter(
    ([id]) => !generated(id.slice(FONT_NAME.length + 1)),
  );
  manifest.contributes.icons = {
    ...Object.fromEntries(marks),
    ...generatedIcons(`./${FONT_PATH}`),
  };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const marks = config.glyphs.filter((glyph) => !generated(glyph.css));
config.glyphs = [...marks, ...dayGlyphs(), ...markGlyphs()];

const font = await build(config);
await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
await publish(font);

console.log(
  `Rebuilt ${FONT_PATH}: ${marks.length} provider marks, ${HEIGHTS.length} day glyphs, a bar mark and its halo, ${font.length} bytes.`,
);
