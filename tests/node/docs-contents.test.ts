import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The docs page numbers its sections by looking each id up in TOC_SECTIONS, so
 * the sidebar and the headings agree only while those two lists agree. They used
 * to carry the number twice, which drifted silently: the sidebar said 07 and the
 * heading said 06, and nothing failed.
 *
 * Reading the source is crude, but the alternative is importing a page component
 * with its SVG diagrams into a node test, and this catches the one thing that
 * actually breaks.
 */
const SOURCE = readFileSync(
  join(process.cwd(), "app", "[locale]", "docs", "page.tsx"),
  "utf8",
);

function tocIds(): string[] {
  const block = SOURCE.match(/const TOC_SECTIONS = \[([\s\S]*?)\] as const;/);
  assert.ok(block, "TOC_SECTIONS not found — did the contents model move?");
  return [...block[1].matchAll(/\{ id: "([a-z0-9-]+)"/g)].map((m) => m[1]);
}

function renderedIds(): string[] {
  return [...SOURCE.matchAll(/<Section id="([a-z0-9-]+)"/g)].map((m) => m[1]);
}

test("every rendered section appears in the contents", () => {
  const toc = new Set(tocIds());
  for (const id of renderedIds()) {
    assert.ok(toc.has(id), `section "${id}" is rendered but missing from TOC_SECTIONS`);
  }
});

test("every contents entry has a section to link to", () => {
  const rendered = new Set(renderedIds());
  for (const id of tocIds()) {
    assert.ok(rendered.has(id), `TOC_SECTIONS lists "${id}" but no section renders it`);
  }
});

test("contents run in the same order as the page", () => {
  // Numbering comes from the TOC index, so a mismatched order shows up as a
  // sidebar that counts 01, 02, 04 while the reader scrolls past 03.
  assert.deepEqual(renderedIds(), tocIds());
});

test("ids are unique", () => {
  const ids = tocIds();
  assert.equal(new Set(ids).size, ids.length, "duplicate id in TOC_SECTIONS");
});

/**
 * The VS XMTP panel is client-side and rendered on the VS detail page. Internal
 * links must go through the locale-aware Link from @/i18n/navigation so they
 * keep the locale prefix (routing uses localePrefix: "always"). Importing the
 * plain `next/link` Link sends every click through an extra redirect and drops
 * the user's locale once a second locale ships.
 */
const LOCALE_AWARE_LINK_FILES = [
  join(process.cwd(), "components", "xmtp", "VsXmtpPanel.tsx"),
];

test("VS XMTP panel uses the locale-aware Link", () => {
  for (const file of LOCALE_AWARE_LINK_FILES) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      !/from\s+(["'])next\/link\1/.test(source),
      `${file} imports Link from "next/link"; use "@/i18n/navigation" instead to keep the locale prefix`,
    );
    assert.match(
      source,
      /import\s*\{\s*Link\s*\}\s*from\s+(")(?:\.\/i18n\/navigation|@\/i18n\/navigation)\1/,
      `${file} should import { Link } from "@/i18n/navigation"`,
    );
  }
});
