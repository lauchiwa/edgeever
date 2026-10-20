import { Base64 } from "js-base64";
import { z } from "zod";
import type { TiptapDoc } from "./content";

/**
 * Client-side encrypted notes.
 *
 * The ciphertext lives only in `content_markdown`, behind an HTML-comment
 * marker (same pattern as poster/table/diagram notes). `content_json` and
 * `content_text` carry a fixed placeholder so search, excerpts, AI and MCP
 * never see the plaintext. Only the note body is encrypted; the title stays
 * plaintext by design.
 */
const MARKER = "edgeever-encrypted-v1";
const MARKER_PATTERN = /<!--\s*edgeever-encrypted-v1:([A-Za-z0-9_-]+)\s*-->/;
const MAX_ENVELOPE_LENGTH = 8_000_000;

export const ENCRYPTED_NOTE_PLACEHOLDER_TEXT = "🔒 Encrypted note";
export const ENCRYPTED_NOTE_PBKDF2_ITERATIONS = 600_000;
export const ENCRYPTED_NOTE_MIN_PASSPHRASE_LENGTH = 8;
/** AES-GCM additional data; native crypto (Android) must authenticate the same bytes. */
export const ENCRYPTED_NOTE_AAD = MARKER;

const B64URL = z.string().min(1).max(MAX_ENVELOPE_LENGTH).regex(/^[A-Za-z0-9_-]+$/);

export const EncryptedNoteEnvelopeSchema = z.object({
  v: z.literal(1),
  kdf: z.object({
    name: z.literal("PBKDF2"),
    hash: z.literal("SHA-256"),
    // Bounded so a crafted envelope cannot stall the client.
    iterations: z.number().int().min(100_000).max(5_000_000),
    salt: B64URL.max(64),
  }),
  cipher: z.object({
    name: z.literal("AES-GCM"),
    iv: B64URL.max(32),
  }),
  ct: B64URL,
});
export type EncryptedNoteEnvelope = z.infer<typeof EncryptedNoteEnvelopeSchema>;

const EncryptedNotePayloadSchema = z.object({
  v: z.literal(1),
  doc: z.object({ type: z.literal("doc") }).passthrough(),
});
export type EncryptedNotePayload = { v: 1; doc: TiptapDoc };

/** Plaintext that AES-GCM seals (as UTF-8): the note document wrapped in a versioned payload. */
export const encryptedNotePayloadJson = (doc: TiptapDoc) => JSON.stringify({ v: 1, doc } satisfies EncryptedNotePayload);

export const parseEncryptedNotePayloadJson = (json: string): TiptapDoc =>
  EncryptedNotePayloadSchema.parse(JSON.parse(json)).doc as TiptapDoc;

export const encryptedNotePlaceholderDoc = (): TiptapDoc => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: ENCRYPTED_NOTE_PLACEHOLDER_TEXT }] }],
});

export const hasEncryptedNoteMarker = (markdown: string | null | undefined) =>
  Boolean(markdown?.includes(`<!-- ${MARKER}:`));

export const parseEncryptedNoteEnvelope = (
  markdown: string | null | undefined,
): EncryptedNoteEnvelope | null => {
  const encoded = markdown?.match(MARKER_PATTERN)?.[1];
  if (!encoded || encoded.length > MAX_ENVELOPE_LENGTH) return null;
  try {
    return EncryptedNoteEnvelopeSchema.parse(JSON.parse(Base64.decode(encoded)));
  } catch {
    return null;
  }
};

export const serializeEncryptedNoteEnvelope = (envelope: EncryptedNoteEnvelope) => {
  const safe = EncryptedNoteEnvelopeSchema.parse(envelope);
  return `${ENCRYPTED_NOTE_PLACEHOLDER_TEXT}\n\n<!-- ${MARKER}:${Base64.encodeURI(JSON.stringify(safe))} -->`;
};

export const getEncryptedNoteSummary = (markdown: string | null | undefined) => ({
  encrypted: hasEncryptedNoteMarker(markdown),
});

const subtle = () => {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WebCrypto is unavailable in this environment.");
  return value;
};

// Copy into a plain ArrayBuffer-backed view; WebCrypto typings reject ArrayBufferLike.
const toBytes = (value: string) => new Uint8Array(Base64.toUint8Array(value));
const toB64 = (bytes: Uint8Array) => Base64.fromUint8Array(bytes, true);

export const createEncryptedNoteSalt = () => toB64(crypto.getRandomValues(new Uint8Array(16)));

/** Derives a non-extractable AES-GCM key from the vault passphrase and a per-note salt. */
export const deriveEncryptedNoteKey = async (
  passphrase: string,
  salt: string,
  iterations = ENCRYPTED_NOTE_PBKDF2_ITERATIONS,
) => {
  const material = await subtle().importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toBytes(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

/**
 * AES-GCM over a UTF-8 payload with a fresh IV. `aad` separates the formats
 * that share this envelope (whole notes, inline secret blocks) so one can
 * never be decrypted as the other.
 */
export const sealEnvelopePayload = async (
  payloadJson: string,
  key: CryptoKey,
  kdf: { salt: string; iterations: number },
  aad: string,
): Promise<EncryptedNoteEnvelope> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(payloadJson),
  );
  return {
    v: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: kdf.iterations, salt: kdf.salt },
    cipher: { name: "AES-GCM", iv: toB64(iv) },
    ct: toB64(new Uint8Array(ciphertext)),
  };
};

/** Throws when the key or `aad` is wrong, or the envelope was tampered with (AES-GCM auth tag). */
export const openEnvelopePayload = async (envelope: EncryptedNoteEnvelope, key: CryptoKey, aad: string) => {
  const plaintext = await subtle().decrypt(
    { name: "AES-GCM", iv: toBytes(envelope.cipher.iv), additionalData: new TextEncoder().encode(aad) },
    key,
    toBytes(envelope.ct),
  );
  return new TextDecoder().decode(plaintext);
};

export const encryptNoteDoc = (
  doc: TiptapDoc,
  key: CryptoKey,
  kdf: { salt: string; iterations: number },
): Promise<EncryptedNoteEnvelope> => sealEnvelopePayload(encryptedNotePayloadJson(doc), key, kdf, ENCRYPTED_NOTE_AAD);

/** Throws when the key is wrong or the envelope was tampered with (AES-GCM auth tag). */
export const decryptNoteDoc = async (envelope: EncryptedNoteEnvelope, key: CryptoKey): Promise<TiptapDoc> =>
  parseEncryptedNotePayloadJson(await openEnvelopePayload(envelope, key, ENCRYPTED_NOTE_AAD));
