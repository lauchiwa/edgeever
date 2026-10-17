import {
  ENCRYPTED_NOTE_AAD,
  encryptedNotePayloadJson,
  parseEncryptedNotePayloadJson,
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

export const ENCRYPTED_NOTE_AUTO_LOCK_MS = 15 * 60 * 1000;

export class EncryptedNoteWrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase");
    this.name = "EncryptedNoteWrongPassphraseError";
  }
}

export type EncryptedNoteVault = ReturnType<typeof createEncryptedNoteVault>;

export const createEncryptedNoteVault = (
  provider: EncryptedNoteCryptoProvider,
  { autoLockMs = ENCRYPTED_NOTE_AUTO_LOCK_MS, now = () => Date.now() } = {},
) => {
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

    /** Decrypts with a typed passphrase; on success it becomes the session passphrase. */
    unlock: async (envelope: EncryptedNoteEnvelope, secret: string) => {
      const key = derive(secret, envelope.kdf.salt, envelope.kdf.iterations);
      let doc: TiptapDoc;
      try {
        doc = await open(envelope, await key);
      } catch {
        throw new EncryptedNoteWrongPassphraseError();
      }
      if (secret !== passphrase) keyCache.clear();
      passphrase = secret;
      keyCache.set(`${envelope.kdf.salt}:${envelope.kdf.iterations}`, key);
      lockedByTimeout = false;
      touch();
      notify();
      return doc;
    },

    /** Decrypts with the session passphrase. Null when locked or when the passphrase does not fit this note. */
    decrypt: async (envelope: EncryptedNoteEnvelope) => {
      const secret = passphrase;
      if (!secret) return null;
      try {
        const doc = await open(envelope, await sessionKey(secret, envelope.kdf.salt, envelope.kdf.iterations));
        touch();
        return doc;
      } catch {
        return null;
      }
    },

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
