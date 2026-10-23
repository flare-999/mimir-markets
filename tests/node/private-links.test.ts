import { test } from "node:test";
import assert from "node:assert";

import {
  rememberPrivateInviteKey,
  getStoredPrivateInviteKey,
  generatePrivateInviteKey,
} from "../../lib/private-links";

const STORAGE_KEY = "proven.privateInviteKeys";

function createLocalStorageShim(): Storage {
  const store = new Map<string, string>();
  const shim = {
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    get length(): number {
      return store.size;
    },
  };
  return shim as unknown as Storage;
}

function withLocalStorage(fn: () => void): void {
  const globals = globalThis as unknown as {
    window?: { window?: unknown; localStorage?: Storage };
    localStorage?: Storage;
  };
  const originalWindow = globals.window;
  const originalLocalStorage = globals.localStorage;
  const storage = createLocalStorageShim();
  try {
    globals.localStorage = storage;
    globals.window = {
      window: globals.window,
      localStorage: storage,
    };
    fn();
  } finally {
    globals.window = originalWindow;
    globals.localStorage = originalLocalStorage;
  }
}

test("rememberPrivateInviteKey ignores empty keys", () => {
  withLocalStorage(() => {
    rememberPrivateInviteKey("claim-1", "");
    assert.deepStrictEqual(getStoredPrivateInviteKey(), {});
    assert.equal(globalThis.localStorage.getItem(STORAGE_KEY), null);
  });
});

test("rememberPrivateInviteKey round trips through localStorage", () => {
  withLocalStorage(() => {
    rememberPrivateInviteKey("claim-1", "abc123");
    rememberPrivateInviteKey("claim-2", "def456");
    assert.deepStrictEqual(getStoredPrivateInviteKey(), {
      "claim-1": "abc123",
      "claim-2": "def456",
    });
  });
});

test("getStoredPrivateInviteKey returns empty map for corrupted JSON", () => {
  withLocalStorage(() => {
    globalThis.localStorage.setItem(STORAGE_KEY, "{not valid json");
    assert.deepStrictEqual(getStoredPrivateInviteKey(), {});
  });
});

test("generatePrivateInviteKey returns 32 hex characters", () => {
  const key = generatePrivateInviteKey();
  assert.matches(key, /^[0-9a-f]{32}$/);
});
