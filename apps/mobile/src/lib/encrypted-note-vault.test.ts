import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  decryptNoteDoc,
  deriveEncryptedNoteKey,
  encryptNoteDoc,
  encryptSecretBlockText,
  parseEncryptedNoteEnvelope,
  type TiptapDoc,
} from "@edgeever/shared";
import { createEncryptedNoteVault, EncryptedNoteWrongPassphraseError, type EncryptedNoteCryptoProvider } from "./encrypted-note-vault";

// Same contract as the native module (modules/edgeever-crypto), on node:crypto.
// Interop of the real Java core is covered by modules/edgeever-crypto/test.
const nodeProvider = (calls = { derive: 0 }): EncryptedNoteCryptoProvider => ({
  deriveKey: async (passphrase, salt, iterations) => {
    calls.derive += 1;
    return pbkdf2Sync(Buffer.from(passphrase, "utf8"), Buffer.from(salt, "base64url"), iterations, 32, "sha256").toString("base64url");
  },
  encrypt: async (key, plaintext, aad) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { iv: iv.toString("base64url"), ct: ct.toString("base64url") };
  },
  decrypt: async (key, iv, ciphertext, aad) => {
    const bytes = Buffer.from(ciphertext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64url"), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString("utf8");
  },
});

const ITERATIONS = 100_000;
const PASSPHRASE = "vault passphrase 密码";
const salt = Buffer.from("fedcba9876543210").toString("base64url");
const doc = (text: string): TiptapDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const webEnvelope = async (text: string, passphrase = PASSPHRASE) =>
  encryptNoteDoc(doc(text), await deriveEncryptedNoteKey(passphrase, salt, ITERATIONS), { salt, iterations: ITERATIONS });

describe("mobile encrypted-note vault", () => {
  test("unlocks a note written on web and re-encrypts it so web can read the edit", async () => {
    const vault = createEncryptedNoteVault(nodeProvider());
    expect(await vault.unlock(await webEnvelope("from web"), PASSPHRASE)).toEqual(doc("from web"));
    expect(vault.isUnlocked()).toBe(true);

    const { envelope, contentMarkdown } = await vault.encrypt(doc("edited on android"), { salt, iterations: ITERATIONS });
    expect(parseEncryptedNoteEnvelope(contentMarkdown)).toEqual(envelope);
    expect(envelope.kdf).toEqual({ name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt });
    expect(await decryptNoteDoc(envelope, await deriveEncryptedNoteKey(PASSPHRASE, salt, ITERATIONS))).toEqual(doc("edited on android"));
    vault.lock();
  });

  test("never puts plaintext into the saved content", async () => {
    const vault = createEncryptedNoteVault(nodeProvider());
    await vault.unlock(await webEnvelope("x"), PASSPHRASE);
    const { contentMarkdown } = await vault.encrypt(doc("bank pin 4242"), { salt, iterations: ITERATIONS });
    expect(contentMarkdown).not.toContain("4242");
    expect(Buffer.from(contentMarkdown).toString("base64")).not.toContain(Buffer.from("4242").toString("base64"));
    vault.lock();
  });

  test("uses a fresh IV on every save and derives the key only once per note", async () => {
    const calls = { derive: 0 };
    const vault = createEncryptedNoteVault(nodeProvider(calls));
    const envelope = await webEnvelope("a");
    await vault.unlock(envelope, PASSPHRASE);
    const first = await vault.encrypt(doc("same"), { salt, iterations: ITERATIONS });
    const second = await vault.encrypt(doc("same"), { salt, iterations: ITERATIONS });
    expect(first.envelope.cipher.iv).not.toBe(second.envelope.cipher.iv);
    expect(await vault.decrypt(envelope)).toEqual(doc("a"));
    expect(calls.derive).toBe(1);
    vault.lock();
  });

  test("a wrong passphrase stays locked and does not replace the session passphrase", async () => {
    const vault = createEncryptedNoteVault(nodeProvider());
    await expect(vault.unlock(await webEnvelope("a"), "wrong passphrase")).rejects.toBeInstanceOf(EncryptedNoteWrongPassphraseError);
    expect(vault.isUnlocked()).toBe(false);

    await vault.unlock(await webEnvelope("a"), PASSPHRASE);
    await expect(vault.unlock(await webEnvelope("a"), "wrong passphrase")).rejects.toBeInstanceOf(EncryptedNoteWrongPassphraseError);
    expect(await vault.decrypt(await webEnvelope("still open"))).toEqual(doc("still open"));
    vault.lock();
  });

  test("decrypt returns null when locked or for a note under another passphrase", async () => {
    const vault = createEncryptedNoteVault(nodeProvider());
    expect(await vault.decrypt(await webEnvelope("a"))).toBeNull();
    await vault.unlock(await webEnvelope("a"), PASSPHRASE);
    expect(await vault.decrypt(await webEnvelope("b", "another passphrase"))).toBeNull();
    vault.lock();
  });

  test("rejects a tampered envelope", async () => {
    const vault = createEncryptedNoteVault(nodeProvider());
    const envelope = await webEnvelope("a");
    await vault.unlock(envelope, PASSPHRASE);
    const bytes = Buffer.from(envelope.ct, "base64url");
    bytes[bytes.length - 1] ^= 1;
    expect(await vault.decrypt({ ...envelope, ct: bytes.toString("base64url") })).toBeNull();
    vault.lock();
  });

  test("locking forgets the passphrase and refuses to encrypt", async () => {
    const vault = createEncryptedNoteVault(nodeProvider());
    let notified = 0;
    vault.subscribe(() => { notified += 1; });
    await vault.unlock(await webEnvelope("a"), PASSPHRASE);
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.wasAutoLocked()).toBe(false);
    expect(notified).toBe(2);
    await expect(vault.encrypt(doc("x"), { salt, iterations: ITERATIONS })).rejects.toThrow("locked");
  });

  test("auto-locks after the idle timeout, also when the timer was paused in the background", async () => {
    let clock = 1_000;
    const vault = createEncryptedNoteVault(nodeProvider(), { autoLockMs: 60_000, now: () => clock });
    await vault.unlock(await webEnvelope("a"), PASSPHRASE);
    clock += 59_000;
    vault.expireIfIdle();
    expect(vault.isUnlocked()).toBe(true);
    vault.touch();
    clock += 59_000;
    vault.expireIfIdle();
    expect(vault.isUnlocked()).toBe(true);
    clock += 1_000;
    vault.expireIfIdle();
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.wasAutoLocked()).toBe(true);
  });

  test("the idle timer itself locks the vault", async () => {
    const vault = createEncryptedNoteVault(nodeProvider(), { autoLockMs: 20 });
    await vault.unlock(await webEnvelope("a"), PASSPHRASE);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.wasAutoLocked()).toBe(true);
  });

  // Fork: inline secret blocks share the passphrase but are bound to their own AAD.
  test("opens a secret block sealed on web and keeps it apart from note envelopes", async () => {
    const block = await encryptSecretBlockText("api key 4242", await deriveEncryptedNoteKey(PASSPHRASE, salt, ITERATIONS), { salt, iterations: ITERATIONS });
    const vault = createEncryptedNoteVault(nodeProvider());
    expect(await vault.decryptSecretBlock(block)).toBeNull();
    await expect(vault.unlockSecretBlock(block, "wrong passphrase")).rejects.toBeInstanceOf(EncryptedNoteWrongPassphraseError);
    expect(vault.isUnlocked()).toBe(false);

    expect(await vault.unlockSecretBlock(block, PASSPHRASE)).toBe("api key 4242");
    expect(await vault.decryptSecretBlock(block)).toBe("api key 4242");
    // A note envelope never opens as a secret block, nor the other way round.
    expect(await vault.decryptSecretBlock(await webEnvelope("note"))).toBeNull();
    expect(await vault.decrypt(block)).toBeNull();
    vault.lock();
    expect(await vault.decryptSecretBlock(block)).toBeNull();
  });
});
