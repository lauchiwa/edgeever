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
