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
  type EncryptedNoteAutoLockMinutes,
  type EncryptedNoteEnvelope,
  type TiptapDoc,
} from "@edgeever/shared";
import { readEncryptedNoteAutoLockMinutes, writeEncryptedNoteAutoLockMinutes } from "./encrypted-note-auto-lock-preference";

/**
 * In-memory vault session for encrypted notes. The passphrase and derived
 * keys live only in this module; nothing is persisted except a per-device
 * verifier (itself an encrypted envelope) used to catch a mistyped vault
 * passphrase when creating a new note. The idle timeout is a per-device
 * preference read on every touch.
 */
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

// The idle deadline is wall-clock time: timers stall while the machine sleeps
// and are throttled in background tabs, so the timer only re-checks in short
// steps and waking up (focus / visible / pageshow) checks right away.
const AUTO_LOCK_CHECK_INTERVAL_MS = 15_000;
let autoLockDeadline = 0;

const scheduleAutoLockCheck = () => {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(checkEncryptedNoteVaultAutoLock, Math.max(0, Math.min(autoLockDeadline - Date.now(), AUTO_LOCK_CHECK_INTERVAL_MS)));
};

/** Locks the vault if the idle deadline has passed, otherwise keeps waiting for it. */
export const checkEncryptedNoteVaultAutoLock = () => {
  if (!passphrase || flushing) return;
  if (Date.now() >= autoLockDeadline) void flushAndLockEncryptedNoteVault(true);
  else scheduleAutoLockCheck();
};

export const touchEncryptedNoteVault = () => {
  if (!passphrase) return;
  autoLockDeadline = Date.now() + readEncryptedNoteAutoLockMinutes() * 60 * 1000;
  scheduleAutoLockCheck();
};

if (typeof window !== "undefined" && typeof window.addEventListener === "function" && typeof document !== "undefined") {
  window.addEventListener("focus", checkEncryptedNoteVaultAutoLock);
  window.addEventListener("pageshow", checkEncryptedNoteVaultAutoLock);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkEncryptedNoteVaultAutoLock();
  });
}

/** Saves the idle timeout and restarts an open session's timer with it. */
export const setEncryptedNoteVaultAutoLockMinutes = (minutes: EncryptedNoteAutoLockMinutes) => {
  writeEncryptedNoteAutoLockMinutes(minutes);
  touchEncryptedNoteVault();
};

// Open editors register a flush so a lock seals their unsaved plaintext with
// the current key first, instead of dropping it.
const flushers = new Set<{ flush: () => Promise<unknown>; afterEditors: boolean }>();
const FLUSH_BEFORE_LOCK_TIMEOUT_MS = 10_000;
let flushing: Promise<void> | null = null;
// True while a lock waits for those saves: the key stays usable for them, but
// every view hides its plaintext and stops taking edits right away.
let sealing = false;

/**
 * Registers a save to run before the vault locks; returns the unregister
 * function. `afterEditors` marks a save that persists the whole note, so it
 * runs after saves that only write into that note (secret-block drafts).
 */
export const registerEncryptedNoteVaultFlush = (flush: () => Promise<unknown>, { afterEditors = false } = {}) => {
  const entry = { flush, afterEditors };
  flushers.add(entry);
  return () => {
    flushers.delete(entry);
  };
};

/** Runs every registered save while the key is still available, then locks. A stuck save cannot keep the vault open. */
export const flushAndLockEncryptedNoteVault = (byTimeout = false): Promise<void> => {
  if (flushing) return flushing;
  if (!passphrase || flushers.size === 0) {
    lockEncryptedNoteVault(byTimeout);
    return Promise.resolve();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Two rounds, so a note is sealed after the drafts it contains have been written into it.
  const registered = [...flushers];
  const runRound = (afterEditors: boolean) =>
    Promise.allSettled(registered.filter((entry) => entry.afterEditors === afterEditors).map((entry) => entry.flush()));
  const pending = runRound(false).then(() => runRound(true));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, FLUSH_BEFORE_LOCK_TIMEOUT_MS);
  });
  sealing = true;
  notify();
  flushing = Promise.race([pending, timeout])
    .then(() => lockEncryptedNoteVault(byTimeout))
    .finally(() => {
      clearTimeout(timer);
      flushing = null;
    });
  return flushing;
};

/** True while a lock is saving open edits; views must already hide plaintext. */
export const isEncryptedNoteVaultSealing = () => sealing;

/**
 * Starts the session with a passphrase that just opened something. A different
 * passphrase first closes the current session, so nothing open under the old
 * one is ever re-sealed with the new one.
 */
const startSession = async (next: string) => {
  // A lock already under way finishes first, so it cannot close the new session.
  if (flushing) await flushing;
  if (passphrase !== null && next !== passphrase) await flushAndLockEncryptedNoteVault();
  if (next !== passphrase) keyCache.clear();
  passphrase = next;
  lockedByTimeout = false;
  touchEncryptedNoteVault();
  notify();
};

export const lockEncryptedNoteVault = (byTimeout = false) => {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = null;
  sealing = false;
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
  await startSession(secret);
};

/** Decrypts with the session passphrase. Returns null when locked or when the session passphrase does not fit this note. */
export const decryptWithEncryptedNoteVault = async (envelope: EncryptedNoteEnvelope) => {
  const secret = passphrase;
  // A closing session opens nothing new.
  if (!secret || sealing) return null;
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
  await startSession(secret);
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
  // A closing session opens nothing new.
  if (!secret || sealing) return null;
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
  await startSession(secret);
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
