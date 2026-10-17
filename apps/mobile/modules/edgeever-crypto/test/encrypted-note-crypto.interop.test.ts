// Runs the Android crypto core (EncryptedNoteCrypto.java) on desktop Java and
// checks it against WebCrypto, which web and Windows use for the same notes.
// A mismatch here means notes written on one platform cannot be opened on the other.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ENCRYPTED_NOTE_AAD,
  decryptNoteDoc,
  deriveEncryptedNoteKey,
  encryptNoteDoc,
  encryptedNotePayloadJson,
  type TiptapDoc,
} from "@edgeever/shared";

const ITERATIONS = 100_000;
// Each case starts a few JVMs.
const TIMEOUT_MS = 30_000;
const javaAvailable = spawnSync("javac", ["-version"]).status === 0;
const moduleDir = join(import.meta.dir, "..");
let classes = "";

const b64 = (value: Uint8Array | string) =>
  Buffer.from(typeof value === "string" ? new TextEncoder().encode(value) : value).toString("base64url");
const java = (...args: string[]) => spawnSync("java", ["-cp", classes, "EncryptedNoteCryptoCli", ...args], { encoding: "utf8" });
const javaOk = (...args: string[]) => {
  const result = java(...args);
  if (result.status !== 0) throw new Error(`java ${args[0]} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
};

const doc: TiptapDoc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "银行 PIN — ünïcødé 🔐" }] },
    { type: "paragraph", content: [{ type: "text", text: "4242", marks: [{ type: "bold" }] }] },
  ],
};
// Non-ASCII on purpose: the passphrase must be hashed as UTF-8 bytes on both sides.
const passphrase = "correct horse 电池 staple";
const salt = Buffer.from("0123456789abcdef").toString("base64url");

const webRawKey = async () => {
  const subtle = globalThis.crypto.subtle;
  const material = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(salt, "base64url"), iterations: ITERATIONS },
    material,
    256,
  );
  return Buffer.from(bits).toString("base64url");
};

describe.skipIf(!javaAvailable)("Android encrypted-note crypto interop with WebCrypto", () => {
  beforeAll(() => {
    classes = mkdtempSync(join(tmpdir(), "edgeever-crypto-"));
    execFileSync("javac", [
      "-d", classes,
      join(moduleDir, "android/src/main/java/org/edgeever/crypto/EncryptedNoteCrypto.java"),
      join(moduleDir, "test/EncryptedNoteCryptoCli.java"),
    ]);
  }, TIMEOUT_MS);
  afterAll(() => {
    if (classes) rmSync(classes, { recursive: true, force: true });
  }, TIMEOUT_MS);

  test("derives the same PBKDF2-SHA256 key from a non-ASCII passphrase", async () => {
    expect(javaOk("derive", b64(passphrase), salt, String(ITERATIONS))).toBe(await webRawKey());
  }, TIMEOUT_MS);

  test("opens a note sealed by WebCrypto", async () => {
    const envelope = await encryptNoteDoc(doc, await deriveEncryptedNoteKey(passphrase, salt, ITERATIONS), { salt, iterations: ITERATIONS });
    const key = javaOk("derive", b64(passphrase), salt, String(ITERATIONS));
    const plaintext = javaOk("decrypt", key, envelope.cipher.iv, envelope.ct, b64(ENCRYPTED_NOTE_AAD));
    expect(Buffer.from(plaintext, "base64url").toString("utf8")).toBe(encryptedNotePayloadJson(doc));
  }, TIMEOUT_MS);

  test("seals a note that WebCrypto opens", async () => {
    const key = javaOk("derive", b64(passphrase), salt, String(ITERATIONS));
    const iv = b64(crypto.getRandomValues(new Uint8Array(12)));
    const ct = javaOk("encrypt", key, iv, b64(encryptedNotePayloadJson(doc)), b64(ENCRYPTED_NOTE_AAD));
    const envelope = {
      v: 1 as const,
      kdf: { name: "PBKDF2" as const, hash: "SHA-256" as const, iterations: ITERATIONS, salt },
      cipher: { name: "AES-GCM" as const, iv },
      ct,
    };
    expect(await decryptNoteDoc(envelope, await deriveEncryptedNoteKey(passphrase, salt, ITERATIONS))).toEqual(doc);
  }, TIMEOUT_MS);

  test("rejects a wrong key, tampered ciphertext and a different AAD", async () => {
    const envelope = await encryptNoteDoc(doc, await deriveEncryptedNoteKey(passphrase, salt, ITERATIONS), { salt, iterations: ITERATIONS });
    const key = javaOk("derive", b64(passphrase), salt, String(ITERATIONS));
    const wrongKey = javaOk("derive", b64("not the passphrase"), salt, String(ITERATIONS));
    const bytes = Buffer.from(envelope.ct, "base64url");
    bytes[0] ^= 1;
    expect(java("decrypt", wrongKey, envelope.cipher.iv, envelope.ct, b64(ENCRYPTED_NOTE_AAD)).status).toBe(3);
    expect(java("decrypt", key, envelope.cipher.iv, bytes.toString("base64url"), b64(ENCRYPTED_NOTE_AAD)).status).toBe(3);
    expect(java("decrypt", key, envelope.cipher.iv, envelope.ct, b64("other-aad")).status).toBe(3);
  }, TIMEOUT_MS);

  test("refuses iteration counts outside the envelope schema bounds", () => {
    for (const iterations of ["99999", "5000001"]) {
      expect(java("derive", b64(passphrase), salt, iterations).status).not.toBe(0);
    }
  }, TIMEOUT_MS);
});
