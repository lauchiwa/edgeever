import { afterEach, describe, expect, test } from "bun:test";
import {
  ENCRYPTED_NOTE_AUTO_LOCK_MINUTE_OPTIONS,
  ENCRYPTED_NOTE_DEFAULT_AUTO_LOCK_MINUTES,
  resolveEncryptedNoteAutoLockMinutes,
} from "@edgeever/shared";
import {
  ENCRYPTED_NOTE_AUTO_LOCK_STORAGE_KEY,
  readEncryptedNoteAutoLockMinutes,
  writeEncryptedNoteAutoLockMinutes,
} from "./encrypted-note-auto-lock-preference.ts";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

const installWindow = ({ failWrites = false } = {}) => {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (failWrites) throw new Error("QuotaExceededError");
        values.set(key, String(value));
      },
    },
  };
  return values;
};

describe("encrypted note auto-lock preference", () => {
  test("defaults to 5 minutes and only accepts the offered choices", () => {
    expect(ENCRYPTED_NOTE_DEFAULT_AUTO_LOCK_MINUTES).toBe(5);
    expect([...ENCRYPTED_NOTE_AUTO_LOCK_MINUTE_OPTIONS]).toEqual([1, 5, 15, 30]);
    for (const stored of [null, undefined, "", "0", "7", "-5", "abc", "1.5"]) {
      expect(resolveEncryptedNoteAutoLockMinutes(stored)).toBe(5);
    }
    expect(resolveEncryptedNoteAutoLockMinutes("1")).toBe(1);
    expect(resolveEncryptedNoteAutoLockMinutes("30")).toBe(30);
  });

  test("reads the default when nothing is stored, then the saved choice", () => {
    const values = installWindow();
    expect(readEncryptedNoteAutoLockMinutes()).toBe(5);
    writeEncryptedNoteAutoLockMinutes(15);
    expect(values.get(ENCRYPTED_NOTE_AUTO_LOCK_STORAGE_KEY)).toBe("15");
    expect(readEncryptedNoteAutoLockMinutes()).toBe(15);
  });

  test("the vault timer follows the preference and restarts when it changes", async () => {
    installWindow();
    const { lockEncryptedNoteVault, openEncryptedNoteVault, setEncryptedNoteVaultAutoLockMinutes } = await import("./encrypted-note-vault.ts");
    const realSetTimeout = globalThis.setTimeout;
    const delays = [];
    globalThis.setTimeout = (handler, delay, ...args) => {
      delays.push(delay);
      return realSetTimeout(() => undefined, 0);
    };
    try {
      writeEncryptedNoteAutoLockMinutes(5);
      await openEncryptedNoteVault("auto-lock-test", "correct horse battery");
      setEncryptedNoteVaultAutoLockMinutes(1);
      expect(delays.slice(-2)).toEqual([5 * 60_000, 60_000]);
      lockEncryptedNoteVault();
      // A locked vault does not arm a timer when the preference changes.
      const armed = delays.length;
      setEncryptedNoteVaultAutoLockMinutes(30);
      expect(delays.length).toBe(armed);
      expect(readEncryptedNoteAutoLockMinutes()).toBe(30);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      lockEncryptedNoteVault();
    }
  });

  test("keeps the choice for this session when storage rejects the write", () => {
    installWindow({ failWrites: true });
    writeEncryptedNoteAutoLockMinutes(1);
    expect(readEncryptedNoteAutoLockMinutes()).toBe(1);
    // A later successful write clears the in-memory fallback.
    installWindow();
    writeEncryptedNoteAutoLockMinutes(30);
    expect(readEncryptedNoteAutoLockMinutes()).toBe(30);
  });
});
