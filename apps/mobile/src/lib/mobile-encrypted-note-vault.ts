import AsyncStorage from "@react-native-async-storage/async-storage";
import { resolveEncryptedNoteAutoLockMinutes, type EncryptedNoteAutoLockMinutes } from "@edgeever/shared";
import { getEdgeEverCrypto } from "../../modules/edgeever-crypto";
import { createEncryptedNoteVault, type EncryptedNoteCryptoProvider } from "./encrypted-note-vault";

// The native module is resolved on first use, so screens that never open an
// encrypted note do not touch it.
const nativeProvider: EncryptedNoteCryptoProvider = {
  deriveKey: (passphrase, salt, iterations) => getEdgeEverCrypto().deriveKey(passphrase, salt, iterations),
  encrypt: (key, plaintext, aad) => getEdgeEverCrypto().encrypt(key, plaintext, aad),
  decrypt: (key, iv, ciphertext, aad) => getEdgeEverCrypto().decrypt(key, iv, ciphertext, aad),
};

/** The app-wide vault session (one passphrase for every encrypted note, like web). */
export const mobileEncryptedNoteVault = createEncryptedNoteVault(nativeProvider);

// Fork: per-device idle timeout. Local only; never synced to the server.
const AUTO_LOCK_MINUTES_KEY = "edgeever.mobile.encryptedNoteAutoLockMinutes";

let autoLockMinutes = resolveEncryptedNoteAutoLockMinutes(null);
let autoLockMinutesChosen = false;

const applyAutoLockMinutes = (minutes: EncryptedNoteAutoLockMinutes) => {
  autoLockMinutes = minutes;
  mobileEncryptedNoteVault.setAutoLockMs(minutes * 60 * 1000);
};

/** Resolves to the stored timeout and applies it to the vault. */
export const loadMobileEncryptedNoteAutoLockMinutes = AsyncStorage.getItem(AUTO_LOCK_MINUTES_KEY)
  .catch(() => null)
  .then((stored) => {
    // A choice made while storage was still loading wins over the stored value.
    if (!autoLockMinutesChosen) applyAutoLockMinutes(resolveEncryptedNoteAutoLockMinutes(stored));
    return autoLockMinutes;
  });

export const getMobileEncryptedNoteAutoLockMinutes = () => autoLockMinutes;

/** Applies the new timeout right away; resolves to false when it could not be stored. */
export const saveMobileEncryptedNoteAutoLockMinutes = async (minutes: EncryptedNoteAutoLockMinutes) => {
  autoLockMinutesChosen = true;
  applyAutoLockMinutes(minutes);
  try {
    await AsyncStorage.setItem(AUTO_LOCK_MINUTES_KEY, String(minutes));
    return true;
  } catch {
    return false;
  }
};
