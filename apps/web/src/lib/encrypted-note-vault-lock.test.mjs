import { afterEach, describe, expect, test } from "bun:test";
import { decryptNoteDoc, deriveEncryptedNoteKey, encryptNoteDoc, parseEncryptedNoteEnvelope } from "@edgeever/shared";
import {
  checkEncryptedNoteVaultAutoLock,
  decryptWithEncryptedNoteVault,
  encryptWithEncryptedNoteVault,
  flushAndLockEncryptedNoteVault,
  isEncryptedNoteVaultSealing,
  isEncryptedNoteVaultUnlocked,
  lockEncryptedNoteVault,
  openEncryptedNoteVault,
  registerEncryptedNoteVaultFlush,
  subscribeEncryptedNoteVault,
  unlockEncryptedNote,
  wasEncryptedNoteVaultAutoLocked,
} from "./encrypted-note-vault.ts";

const ITERATIONS = 100_000;
const salt = Buffer.from("0123456789abcdef").toString("base64url");
const doc = (text) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const sealedWith = async (passphrase, text) =>
  encryptNoteDoc(doc(text), await deriveEncryptedNoteKey(passphrase, salt, ITERATIONS), { salt, iterations: ITERATIONS });
const opensWith = async (markdown, passphrase) =>
  decryptNoteDoc(parseEncryptedNoteEnvelope(markdown), await deriveEncryptedNoteKey(passphrase, salt, ITERATIONS));

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  lockEncryptedNoteVault();
});

describe("encrypted note vault locking", () => {
  test("a lock seals pending edits with the current key before dropping it", async () => {
    await openEncryptedNoteVault("lock-test", "first passphrase");
    let saved = null;
    cleanups.push(registerEncryptedNoteVaultFlush(async () => {
      expect(isEncryptedNoteVaultUnlocked()).toBe(true);
      saved = (await encryptWithEncryptedNoteVault(doc("unsaved edit"), { salt, iterations: ITERATIONS })).contentMarkdown;
    }));
    await flushAndLockEncryptedNoteVault(true);
    expect(isEncryptedNoteVaultUnlocked()).toBe(false);
    expect(wasEncryptedNoteVaultAutoLocked()).toBe(true);
    expect(await opensWith(saved, "first passphrase")).toEqual(doc("unsaved edit"));
  });

  test("a sealing lock hides plaintext at once but lets the pending save use the key", async () => {
    await openEncryptedNoteVault("lock-test", "first passphrase");
    const note = await sealedWith("first passphrase", "note");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    // A failed assertion must not leave the lock waiting on this gate for later tests.
    cleanups.push(() => release());
    let sealed = null;
    cleanups.push(registerEncryptedNoteVaultFlush(async () => {
      await gate;
      sealed = (await encryptWithEncryptedNoteVault(doc("late edit"), { salt, iterations: ITERATIONS })).contentMarkdown;
    }));
    const locking = flushAndLockEncryptedNoteVault();
    expect(isEncryptedNoteVaultSealing()).toBe(true);
    expect(isEncryptedNoteVaultUnlocked()).toBe(true);
    // Nothing new opens while closing.
    expect(await decryptWithEncryptedNoteVault(note)).toBeNull();
    // An unlock during the lock waits for it instead of being closed by it.
    const reopening = unlockEncryptedNote("lock-test", note, "first passphrase");
    release();
    await locking;
    expect(await reopening).toEqual(doc("note"));
    expect(isEncryptedNoteVaultSealing()).toBe(false);
    expect(isEncryptedNoteVaultUnlocked()).toBe(true);
    expect(await opensWith(sealed, "first passphrase")).toEqual(doc("late edit"));
  });

  test("a note is sealed after the drafts it contains have been written into it", async () => {
    await openEncryptedNoteVault("lock-test", "first passphrase");
    const order = [];
    // Registered first, but the note must still be saved last.
    cleanups.push(registerEncryptedNoteVaultFlush(async () => { order.push("note"); }, { afterEditors: true }));
    cleanups.push(registerEncryptedNoteVaultFlush(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("block");
    }));
    await flushAndLockEncryptedNoteVault();
    expect(order).toEqual(["block", "note"]);
  });

  test("a failing save still locks the vault", async () => {
    await openEncryptedNoteVault("lock-test", "first passphrase");
    cleanups.push(registerEncryptedNoteVaultFlush(async () => { throw new Error("offline"); }));
    await flushAndLockEncryptedNoteVault();
    expect(isEncryptedNoteVaultUnlocked()).toBe(false);
  });

  test("unlocking with another passphrase locks first, so open edits keep their own passphrase", async () => {
    await openEncryptedNoteVault("lock-test", "first passphrase");
    let flushed = null;
    cleanups.push(registerEncryptedNoteVaultFlush(async () => {
      if (!isEncryptedNoteVaultUnlocked()) return;
      flushed = (await encryptWithEncryptedNoteVault(doc("note A edit"), { salt, iterations: ITERATIONS })).contentMarkdown;
    }));
    const states = [];
    cleanups.push(subscribeEncryptedNoteVault(() => states.push(isEncryptedNoteVaultUnlocked())));

    expect(await unlockEncryptedNote("lock-test", await sealedWith("second passphrase", "note B"), "second passphrase")).toEqual(doc("note B"));
    expect(await opensWith(flushed, "first passphrase")).toEqual(doc("note A edit"));
    // Sealing (still unlocked), locked, then the new session.
    expect(states).toEqual([true, false, true]);
    const next = await encryptWithEncryptedNoteVault(doc("new"), { salt, iterations: ITERATIONS });
    expect(await opensWith(next.contentMarkdown, "second passphrase")).toEqual(doc("new"));
  });

  test("the idle deadline follows the wall clock, so time spent asleep still counts", async () => {
    const realNow = Date.now;
    cleanups.push(() => { Date.now = realNow; });
    await openEncryptedNoteVault("lock-test", "first passphrase");
    const start = realNow();
    Date.now = () => start + 60_000;
    checkEncryptedNoteVaultAutoLock();
    expect(isEncryptedNoteVaultUnlocked()).toBe(true);
    // Default idle timeout is 5 minutes; a wake-up after that locks at once.
    Date.now = () => start + 5 * 60_000 + 1;
    const locked = new Promise((resolve) => {
      cleanups.push(subscribeEncryptedNoteVault(() => {
        if (!isEncryptedNoteVaultUnlocked()) resolve();
      }));
    });
    checkEncryptedNoteVaultAutoLock();
    await locked;
    expect(wasEncryptedNoteVaultAutoLocked()).toBe(true);
  });

  test("the same passphrase does not interrupt the open session", async () => {
    await openEncryptedNoteVault("lock-test", "first passphrase");
    let flushes = 0;
    cleanups.push(registerEncryptedNoteVaultFlush(async () => { flushes += 1; }));
    await unlockEncryptedNote("lock-test", await sealedWith("first passphrase", "other note"), "first passphrase");
    expect(flushes).toBe(0);
    expect(isEncryptedNoteVaultUnlocked()).toBe(true);
  });
});
