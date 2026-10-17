import { requireNativeModule } from "expo";

/**
 * Native PBKDF2-SHA256 and AES-256-GCM for encrypted notes. Hermes has no
 * WebCrypto, and 600k PBKDF2 rounds in JavaScript take far too long on a phone.
 * Keys, salts, IVs and ciphertext cross the bridge as unpadded base64url; the
 * plaintext is the payload JSON string, sealed as UTF-8.
 */
export type EdgeEverCryptoNativeModule = {
  deriveKey: (passphrase: string, salt: string, iterations: number) => Promise<string>;
  encrypt: (key: string, plaintext: string, aad: string) => Promise<{ iv: string; ct: string }>;
  decrypt: (key: string, iv: string, ciphertext: string, aad: string) => Promise<string>;
};

export const getEdgeEverCrypto = () => requireNativeModule<EdgeEverCryptoNativeModule>("EdgeEverCrypto");
