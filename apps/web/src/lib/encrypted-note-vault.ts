import {
  ENCRYPTED_NOTE_PBKDF2_ITERATIONS,
  createEncryptedNoteSalt,
  createSecretBlockKdf,
  decryptNoteDoc,
  decryptSecretBlockText,
  encryptSecretBlockText,
  deriveEncryptedNoteKey,
  encryptNoteDoc,
  serializeEncryptedNoteEnvelope,
  parseEncryptedNoteEnvelope,
  type EncryptedNoteEnvelope,
  type TiptapDoc,
} from "@edgeever/shared";

/**
 * In-memory vault session for encrypted notes. The passphrase and derived
 * keys live only in this module; nothing is persisted except a per-device
 * verifier (itself an encrypted envelope) used to catch a mistyped vault
 * passphrase when creating a new note.
 */
const AUTO_LOCK_MS = 15 * 60 * 1000;
const VERIFIER_STORAGE_PREFIX = "edgeever.encrypted-note-verifier:";
const VERIFIER_DOC: TiptapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "edgeever-vault-check" }] }] };

let passphrase: string | null = null;
let autoLockTimer: ReturnType<typeof setTimeout> | null = null;
let lockedByTimeout = false;
const keyCache = new Map<string, Promise<CryptoKey>>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

const keyFor = (secret: string, salt: string, iterations: number) => {
  const cacheKey = `${salt}:${iterations}`;
  if (secret !== passphrase) return deriveEncryptedNoteKey(secret, salt, iterations);
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = deriveEncryptedNoteKey(secret, salt, iterations);
    keyCache.set(cacheKey, key);
    key.catch(() => keyCache.delete(cacheKey));
  }
  return key;
};

export const touchEncryptedNoteVault = () => {
  if (!passphrase) return;
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(() => lockEncryptedNoteVault(true), AUTO_LOCK_MS);
};

const setSessionPassphrase = (next: string) => {
  if (next !== passphrase) keyCache.clear();
  passphrase = next;
  lockedByTimeout = false;
  touchEncryptedNoteVault();
  notify();
};

export const lockEncryptedNoteVault = (byTimeout = false) => {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = null;
  passphrase = null;
  keyCache.clear();
  lockedByTimeout = byTimeout;
  notify();
};

export const subscribeEncryptedNoteVault = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const isEncryptedNoteVaultUnlocked = () => passphrase !== null;
export const wasEncryptedNoteVaultAutoLocked = () => lockedByTimeout;

const verifierKey = (scope: string) => `${VERIFIER_STORAGE_PREFIX}${scope}`;

const readVerifier = (scope: string): EncryptedNoteEnvelope | null => {
  try {
    return parseEncryptedNoteEnvelope(window.localStorage.getItem(verifierKey(scope)));
  } catch {
    return null;
  }
};

const writeVerifier = async (scope: string, secret: string) => {
  try {
    const salt = createEncryptedNoteSalt();
    const key = await deriveEncryptedNoteKey(secret, salt);
    const envelope = await encryptNoteDoc(VERIFIER_DOC, key, { salt, iterations: ENCRYPTED_NOTE_PBKDF2_ITERATIONS });
    window.localStorage.setItem(verifierKey(scope), serializeEncryptedNoteEnvelope(envelope));
  } catch {
    // The verifier is a typo guard only; failing to store it must not block saving.
  }
};

export const hasEncryptedNoteVaultVerifier = (scope: string) => readVerifier(scope) !== null;

/** Checks a candidate passphrase against this device's verifier. True when no verifier exists yet. */
export const verifyEncryptedNoteVaultPassphrase = async (scope: string, secret: string) => {
  const verifier = readVerifier(scope);
  if (!verifier) return true;
  try {
    await decryptNoteDoc(verifier, await deriveEncryptedNoteKey(secret, verifier.kdf.salt, verifier.kdf.iterations));
    return true;
  } catch {
    return false;
  }
};

/** Starts a vault session with an already-verified passphrase (used when creating a note). */
export const openEncryptedNoteVault = async (scope: string, secret: string) => {
  if (!readVerifier(scope)) await writeVerifier(scope, secret);
  setSessionPassphrase(secret);
};

/** Decrypts with the session passphrase. Returns null when locked or when the session passphrase does not fit this note. */
export const decryptWithEncryptedNoteVault = async (envelope: EncryptedNoteEnvelope) => {
  const secret = passphrase;
  if (!secret) return null;
  try {
    const doc = await decryptNoteDoc(envelope, await keyFor(secret, envelope.kdf.salt, envelope.kdf.iterations));
    touchEncryptedNoteVault();
    return doc;
  } catch {
    return null;
  }
};

/** Decrypts with a typed passphrase; on success it becomes the session passphrase. Throws on a wrong passphrase. */
export const unlockEncryptedNote = async (scope: string, envelope: EncryptedNoteEnvelope, secret: string) => {
  const doc = await decryptNoteDoc(envelope, await deriveEncryptedNoteKey(secret, envelope.kdf.salt, envelope.kdf.iterations));
  setSessionPassphrase(secret);
  if (!readVerifier(scope)) await writeVerifier(scope, secret);
  return doc;
};

/**
 * Encrypts a document with the session passphrase. `kdf` reuses the note's
 * existing salt so repeated autosaves skip PBKDF2; each save uses a fresh IV.
 */
export const encryptWithEncryptedNoteVault = async (
  doc: TiptapDoc,
  kdf?: { salt: string; iterations: number },
) => {
  const secret = passphrase;
  if (!secret) throw new Error("Encrypted note vault is locked.");
  const params = kdf ?? { salt: createEncryptedNoteSalt(), iterations: ENCRYPTED_NOTE_PBKDF2_ITERATIONS };
  const envelope = await encryptNoteDoc(doc, await keyFor(secret, params.salt, params.iterations), params);
  touchEncryptedNoteVault();
  return { envelope, contentMarkdown: serializeEncryptedNoteEnvelope(envelope) };
};

/** Opens a secret block with the session passphrase. Null when locked or the passphrase does not fit. */
export const decryptSecretBlockWithVault = async (envelope: EncryptedNoteEnvelope) => {
  const secret = passphrase;
  if (!secret) return null;
  try {
    const text = await decryptSecretBlockText(envelope, await keyFor(secret, envelope.kdf.salt, envelope.kdf.iterations));
    touchEncryptedNoteVault();
    return text;
  } catch {
    return null;
  }
};

/** Opens a secret block with a typed passphrase; on success it becomes the session passphrase. Throws on a wrong one. */
export const unlockSecretBlock = async (scope: string, envelope: EncryptedNoteEnvelope, secret: string) => {
  const text = await decryptSecretBlockText(envelope, await deriveEncryptedNoteKey(secret, envelope.kdf.salt, envelope.kdf.iterations));
  setSessionPassphrase(secret);
  if (!readVerifier(scope)) await writeVerifier(scope, secret);
  return text;
};

/** Seals secret block text with the session passphrase, reusing the note's block salt when given. */
export const encryptSecretBlockWithVault = async (text: string, kdf?: { salt: string; iterations: number } | null) => {
  const secret = passphrase;
  if (!secret) throw new Error("Encrypted note vault is locked.");
  const params = kdf ?? createSecretBlockKdf();
  const envelope = await encryptSecretBlockText(text, await keyFor(secret, params.salt, params.iterations), params);
  touchEncryptedNoteVault();
  return envelope;
};
