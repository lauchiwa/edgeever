import { describe, expect, test } from "bun:test";
import { SECRET_BLOCKS_CLIENT_FEATURE } from "@edgeever/shared";
import {
  decryptSecretBlockWithVault,
  encryptSecretBlockWithVault,
  lockEncryptedNoteVault,
  openEncryptedNoteVault,
  unlockSecretBlock,
} from "./encrypted-note-vault.ts";
import {
  readRevealedSecret,
  rememberRevealedSecret,
  secretBlocksClientFeatures,
  setSecretBlocksServerSupport,
} from "./secret-blocks.ts";

describe("secret block vault session", () => {
  test("seals with the session passphrase and only opens with the right one", async () => {
    await openEncryptedNoteVault("test-scope", "correct horse battery");
    const envelope = await encryptSecretBlockWithVault("db-password-123");
    expect(await decryptSecretBlockWithVault(envelope)).toBe("db-password-123");
    // Blocks in one note share a salt so the key is derived once.
    const second = await encryptSecretBlockWithVault("token", envelope.kdf);
    expect(second.kdf.salt).toBe(envelope.kdf.salt);
    expect(second.cipher.iv).not.toBe(envelope.cipher.iv);

    rememberRevealedSecret("block:iv", "db-password-123");
    lockEncryptedNoteVault();
    expect(readRevealedSecret("block:iv")).toBeNull();
    expect(await decryptSecretBlockWithVault(envelope)).toBeNull();
    await expect(unlockSecretBlock("test-scope", envelope, "wrong passphrase")).rejects.toThrow();
    expect(await unlockSecretBlock("test-scope", envelope, "correct horse battery")).toBe("db-password-123");
    lockEncryptedNoteVault();
  });

  test("declares the client feature only to servers that advertise it", () => {
    setSecretBlocksServerSupport(false);
    expect(secretBlocksClientFeatures()).toEqual([]);
    setSecretBlocksServerSupport(true);
    expect(secretBlocksClientFeatures()).toEqual([SECRET_BLOCKS_CLIENT_FEATURE]);
    setSecretBlocksServerSupport(false);
  });
});
