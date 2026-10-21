import { resolveEncryptedNoteAutoLockMinutes, type EncryptedNoteAutoLockMinutes } from "@edgeever/shared";

// Fork: per-device vault idle timeout. Local only; never synced to the server.
export const ENCRYPTED_NOTE_AUTO_LOCK_STORAGE_KEY = "edgeever.encrypted-note.autoLockMinutes";

// Holds the latest choice when localStorage rejects the write, so the setting
// stays consistent for the rest of the session.
let unsavedAutoLockMinutes: EncryptedNoteAutoLockMinutes | null = null;

export const readEncryptedNoteAutoLockMinutes = (): EncryptedNoteAutoLockMinutes => {
  if (unsavedAutoLockMinutes !== null) return unsavedAutoLockMinutes;
  if (typeof window === "undefined") return resolveEncryptedNoteAutoLockMinutes(null);
  try {
    return resolveEncryptedNoteAutoLockMinutes(window.localStorage?.getItem(ENCRYPTED_NOTE_AUTO_LOCK_STORAGE_KEY) ?? null);
  } catch {
    return resolveEncryptedNoteAutoLockMinutes(null);
  }
};

export const writeEncryptedNoteAutoLockMinutes = (minutes: EncryptedNoteAutoLockMinutes) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(ENCRYPTED_NOTE_AUTO_LOCK_STORAGE_KEY, String(minutes));
    unsavedAutoLockMinutes = null;
  } catch {
    // Private mode / blocked storage — keep the preference in memory for this session.
    unsavedAutoLockMinutes = minutes;
  }
};
