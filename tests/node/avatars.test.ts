import assert from "node:assert/strict";
import test from "node:test";

import { openPeepsAvatar } from "../../lib/avatars";

test("openPeepsAvatar includes default background color when unspecified", () => {
  const result = openPeepsAvatar("agent-alice");
  const url = new URL(result);

  assert.equal(url.origin, "https://api.dicebear.com");
  assert.equal(url.pathname, "/9.x/open-peeps/svg");
  assert.equal(url.searchParams.get("seed"), "agent-alice");
  assert.equal(url.searchParams.get("backgroundColor"), "0b1020");
  assert.equal(url.searchParams.size, 2);
});

test("openPeepsAvatar omits backgroundColor when background is null", () => {
  const result = openPeepsAvatar("agent-bob", null);
  const url = new URL(result);

  assert.equal(url.origin, "https://api.dicebear.com");
  assert.equal(url.pathname, "/9.x/open-peeps/svg");
  assert.equal(url.searchParams.get("seed"), "agent-bob");
  assert.equal(url.searchParams.has("backgroundColor"), false);
  assert.equal(url.searchParams.get("backgroundColor"), null);
  assert.equal(url.searchParams.size, 1);
});

test("openPeepsAvatar respects custom background color when provided", () => {
  const result = openPeepsAvatar("agent-charlie", "123456");
  const url = new URL(result);

  assert.equal(url.searchParams.get("seed"), "agent-charlie");
  assert.equal(url.searchParams.get("backgroundColor"), "123456");
  assert.equal(url.searchParams.size, 2);
});

test("openPeepsAvatar falls back to mimir for whitespace-only and empty seeds", () => {
  for (const emptySeed of ["", "   ", "\t\n  \r\n", "     "]) {
    const result = openPeepsAvatar(emptySeed);
    const url = new URL(result);

    assert.equal(url.searchParams.get("seed"), "mimir");
    assert.equal(url.searchParams.get("backgroundColor"), "0b1020");
  }

  // Leading and trailing whitespace are trimmed from valid seeds
  const trimmedResult = openPeepsAvatar("   agent-trimmed   ");
  const trimmedUrl = new URL(trimmedResult);
  assert.equal(trimmedUrl.searchParams.get("seed"), "agent-trimmed");
});

test("openPeepsAvatar encodes spaces, ampersands, hashes, and non-ASCII characters in seed", () => {
  const seedWithSpecialChars = "  council & lead #42 🤖 \u00e9l\u00e8ve  ";
  const result = openPeepsAvatar(seedWithSpecialChars);
  const url = new URL(result);

  // Asserting on searchParams ensures the URL was parsed correctly by standard URL parser:
  // - spaces didn't break URL
  // - '&' was not treated as a query parameter separator
  // - '#' was not treated as URL hash fragment delimiter
  // - non-ASCII characters were percent-encoded and correctly decoded back by searchParams
  assert.equal(url.searchParams.get("seed"), "council & lead #42 🤖 \u00e9l\u00e8ve");
  assert.equal(url.searchParams.get("backgroundColor"), "0b1020");
  assert.equal(url.hash, "");
  assert.equal(url.searchParams.size, 2);

  const cases = [
    { input: "name with spaces", expected: "name with spaces" },
    { input: "key&value=123", expected: "key&value=123" },
    { input: "hash#fragment", expected: "hash#fragment" },
    { input: "ünicöde-🚀-日本語", expected: "ünicöde-🚀-日本語" },
  ];

  for (const { input, expected } of cases) {
    const caseResult = openPeepsAvatar(input);
    const parsed = new URL(caseResult);

    assert.equal(parsed.searchParams.get("seed"), expected);
    assert.equal(parsed.searchParams.get("backgroundColor"), "0b1020");
    assert.equal(parsed.hash, "");
    assert.equal(parsed.searchParams.size, 2);
  }
});
