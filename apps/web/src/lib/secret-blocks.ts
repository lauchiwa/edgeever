import { SECRET_BLOCKS_CLIENT_FEATURE } from "@edgeever/shared";
import { subscribeEncryptedNoteVault, isEncryptedNoteVaultUnlocked } from "@/lib/encrypted-note-vault";

/**
 * Fork feature: inline secret blocks. Session-wide state the editor and API
 * client share without threading props through upstream components.
 */
let serverSupport = false;
let vaultScope = "";

/** Set from the session's server features; the editor offers secret blocks only when true. */
export const setSecretBlocksServerSupport = (supported: boolean) => {
  serverSupport = supported;
};

export const secretBlocksSupported = () => serverSupport;

/** The client declares the feature only to servers that advertise it, so old servers never see the header. */
export const secretBlocksClientFeatures = (): readonly string[] => (serverSupport ? [SECRET_BLOCKS_CLIENT_FEATURE] : []);

export const setSecretBlocksVaultScope = (scope: string) => {
  vaultScope = scope;
};

export const getSecretBlocksVaultScope = () => vaultScope;

// Plaintext of revealed blocks, keyed by block id and IV, so an editor reload
// (for example after our own save syncs back) does not hide a block the user
// is reading. Memory only; cleared whenever the vault locks.
const revealed = new Map<string, string>();

export const secretBlockRevealKey = (id: string, iv: string) => `${id}:${iv}`;
export const readRevealedSecret = (key: string) => revealed.get(key) ?? null;
export const rememberRevealedSecret = (key: string, text: string) => {
  revealed.set(key, text);
};
export const forgetRevealedSecret = (key: string) => {
  revealed.delete(key);
};

subscribeEncryptedNoteVault(() => {
  if (!isEncryptedNoteVaultUnlocked()) revealed.clear();
});
