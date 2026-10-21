import {
  ENCRYPTED_NOTE_AAD,
  ENCRYPTED_NOTE_DEFAULT_AUTO_LOCK_MINUTES,
  encryptedNotePayloadJson,
  parseEncryptedNotePayloadJson,
  parseSecretBlockPayloadJson,
  SECRET_BLOCK_AAD,
  serializeEncryptedNoteEnvelope,
  type EncryptedNoteEnvelope,
  type TiptapDoc,
} from "@edgeever/shared";

/**
 * In-memory vault session for encrypted notes on mobile (mirror of the web
 * vault in apps/web/src/lib/encrypted-note-vault.ts). The passphrase and derived
 * keys live only in this object; nothing is written to storage. The crypto
 * provider is injected so tests can run without the native module.
 */
export type EncryptedNoteCryptoProvider = {
  /** PBKDF2-SHA256 → 32-byte key, base64url. */
  deriveKey: (passphrase: string, salt: string, iterations: number) => Promise<string>;
  /** AES-256-GCM over the UTF-8 plaintext with a fresh random IV. */
  encrypt: (key: string, plaintext: string, aad: string) => Promise<{ iv: string; ct: string }>;
  /** Rejects when the key is wrong or the ciphertext was changed. */
  decrypt: (key: string, iv: string, ciphertext: string, aad: string) => Promise<string>;
};

export const ENCRYPTED_NOTE_AUTO_LOCK_MS = ENCRYPTED_NOTE_DEFAULT_AUTO_LOCK_MINUTES * 60 * 1000;

export class EncryptedNoteWrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase");
    this.name = "EncryptedNoteWrongPassphraseError";
  }
}

export type EncryptedNoteVault = ReturnType<typeof createEncryptedNoteVault>;

export const createEncryptedNoteVault = (
  provider: EncryptedNoteCryptoProvider,
  { autoLockMs: initialAutoLockMs = ENCRYPTED_NOTE_AUTO_LOCK_MS, now = () => Date.now() } = {},
) => {
  // The device preference loads asynchronously, so the timeout can change after creation.
  let autoLockMs = initialAutoLockMs;
  let passphrase: string | null = null;
  let lastActivity = 0;
  let autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  let lockedByTimeout = false;
  const keyCache = new Map<string, Promise<string>>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const derive = (secret: string, salt: string, iterations: number) => provider.deriveKey(secret, salt, iterations);

  const sessionKey = (secret: string, salt: string, iterations: number) => {
    const cacheKey = `${salt}:${iterations}`;
    let key = keyCache.get(cacheKey);
    if (!key) {
      key = derive(secret, salt, iterations);
      keyCache.set(cacheKey, key);
      key.catch(() => keyCache.delete(cacheKey));
    }
    return key;
  };

  const lock = (byTimeout = false) => {
    if (autoLockTimer) clearTimeout(autoLockTimer);
    autoLockTimer = null;
    const changed = passphrase !== null || lockedByTimeout !== byTimeout;
    passphrase = null;
    keyCache.clear();
    lockedByTimeout = byTimeout;
    if (changed) notify();
  };

  const touch = () => {
    if (!passphrase) return;
    lastActivity = now();
    if (autoLockTimer) clearTimeout(autoLockTimer);
    autoLockTimer = setTimeout(() => lock(true), autoLockMs);
  };

  const open = async (envelope: EncryptedNoteEnvelope, key: string) =>
    parseEncryptedNotePayloadJson(await provider.decrypt(key, envelope.cipher.iv, envelope.ct, ENCRYPTED_NOTE_AAD));
  // Fork: inline secret blocks share the vault passphrase but use their own AAD/payload.
  const openSecretBlock = async (envelope: EncryptedNoteEnvelope, key: string) =>
    parseSecretBlockPayloadJson(await provider.decrypt(key, envelope.cipher.iv, envelope.ct, SECRET_BLOCK_AAD));

  const unlockWith = async <T>(
    envelope: EncryptedNoteEnvelope,
    secret: string,
    read: (envelope: EncryptedNoteEnvelope, key: string) => Promise<T>,
  ) => {
    const key = derive(secret, envelope.kdf.salt, envelope.kdf.iterations);
    let value: T;
    try {
      value = await read(envelope, await key);
    } catch {
      throw new EncryptedNoteWrongPassphraseError();
    }
    if (secret !== passphrase) keyCache.clear();
    passphrase = secret;
    keyCache.set(`${envelope.kdf.salt}:${envelope.kdf.iterations}`, key);
    lockedByTimeout = false;
    touch();
    notify();
    return value;
  };

  const decryptWith = async <T>(
    envelope: EncryptedNoteEnvelope,
    read: (envelope: EncryptedNoteEnvelope, key: string) => Promise<T>,
  ) => {
    const secret = passphrase;
    if (!secret) return null;
    try {
      const value = await read(envelope, await sessionKey(secret, envelope.kdf.salt, envelope.kdf.iterations));
      touch();
      return value;
    } catch {
      return null;
    }
  };

  return {
    isUnlocked: () => passphrase !== null,
    wasAutoLocked: () => lockedByTimeout,
    lock: () => lock(false),
    touch,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * JS timers stop while the app is in the background, so the idle timeout is
     * re-checked against the wall clock when the app returns to the foreground.
     */
    expireIfIdle: () => {
      if (passphrase && now() - lastActivity >= autoLockMs) lock(true);
    },

    /**
     * Changes the idle timeout. An open session keeps its last activity time, so
     * a shorter timeout that has already elapsed locks right away.
     */
    setAutoLockMs: (next: number) => {
      autoLockMs = next;
      if (!passphrase) return;
      const remaining = autoLockMs - (now() - lastActivity);
      if (remaining <= 0) {
        lock(true);
        return;
      }
      if (autoLockTimer) clearTimeout(autoLockTimer);
      autoLockTimer = setTimeout(() => lock(true), remaining);
    },

    /** Decrypts with a typed passphrase; on success it becomes the session passphrase. */
    unlock: (envelope: EncryptedNoteEnvelope, secret: string): Promise<TiptapDoc> => unlockWith(envelope, secret, open),

    /** Decrypts with the session passphrase. Null when locked or when the passphrase does not fit this note. */
    decrypt: (envelope: EncryptedNoteEnvelope) => decryptWith(envelope, open),

    /** Fork: same as `unlock`, for one inline secret block; resolves to its plaintext. */
    unlockSecretBlock: (envelope: EncryptedNoteEnvelope, secret: string) => unlockWith(envelope, secret, openSecretBlock),

    /** Fork: same as `decrypt`, for one inline secret block. */
    decryptSecretBlock: (envelope: EncryptedNoteEnvelope) => decryptWith(envelope, openSecretBlock),

    /**
     * Re-encrypts an existing note with its own salt (so autosaves skip PBKDF2)
     * and a fresh IV. Returns the content_markdown to save.
     */
    encrypt: async (doc: TiptapDoc, kdf: { salt: string; iterations: number }) => {
      const secret = passphrase;
      if (!secret) throw new Error("Encrypted note vault is locked.");
      const key = await sessionKey(secret, kdf.salt, kdf.iterations);
      const sealed = await provider.encrypt(key, encryptedNotePayloadJson(doc), ENCRYPTED_NOTE_AAD);
      const envelope: EncryptedNoteEnvelope = {
        v: 1,
        kdf: { name: "PBKDF2", hash: "SHA-256", iterations: kdf.iterations, salt: kdf.salt },
        cipher: { name: "AES-GCM", iv: sealed.iv },
        ct: sealed.ct,
      };
      touch();
      return { envelope, contentMarkdown: serializeEncryptedNoteEnvelope(envelope) };
    },
  };
};
