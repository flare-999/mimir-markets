import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert";

const root = join(__dirname, "..", "..");

const files = [
  "app/[locale]/council/page.tsx",
  "app/[locale]/stats/page.tsx",
  "app/[locale]/profile/[address]/page.tsx",
];

describe("locale-aware Link imports", () => {
  for (const relative of files) {
    it(`${relative} does not import next/link`, () => {
      const source = readFileSync(join(root, relative), "utf-8");
      const importsNextLink =
        /from\s+['"]next\/link['"]/.test(source);
      assert.strictEqual(
        importsNextLink,
        false,
        `${relative} must not import from "next/link"; use "@ii18n/navigation" instead.`,
      );
    });

    it(`${relative} imports the locale-aware Link from @/i18n/navigation`, () => {
      const source = readFileSync(join(root, relative), "utf-8");
      const importsLocaleLink =
        /from\s+['"]@\/i18n\/navigation['"]/.test(source);
      assert.strictEqual(
        importsLocaleLink,
        true,
        `${relative} must import the locale-aware Link from "@i18n/navigation".`,
      );
    });
  }
});
