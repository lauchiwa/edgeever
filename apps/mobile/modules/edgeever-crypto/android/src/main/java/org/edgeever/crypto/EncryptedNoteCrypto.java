package org.edgeever.crypto;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Encrypted-note primitives matching WebCrypto in packages/shared/src/encrypted-note.ts:
 * PBKDF2-HMAC-SHA256 (UTF-8 passphrase, 32-byte key) and AES-256-GCM (12-byte IV,
 * 128-bit tag appended to the ciphertext). Plain JVM APIs only, so the same file is
 * compiled and checked against WebCrypto on desktop Java (see the interop test).
 */
public final class EncryptedNoteCrypto {
  public static final int KEY_BYTES = 32;
  public static final int IV_BYTES = 12;
  public static final int TAG_BITS = 128;
  // Same bounds as EncryptedNoteEnvelopeSchema, so a crafted envelope cannot stall the device.
  public static final int MIN_ITERATIONS = 100_000;
  public static final int MAX_ITERATIONS = 5_000_000;

  private static final SecureRandom RANDOM = new SecureRandom();

  private EncryptedNoteCrypto() {}

  public static byte[] deriveKey(String passphrase, byte[] salt, int iterations) throws GeneralSecurityException {
    if (passphrase == null || passphrase.isEmpty()) throw new GeneralSecurityException("Empty passphrase");
    if (salt == null || salt.length == 0) throw new GeneralSecurityException("Empty salt");
    if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
      throw new GeneralSecurityException("Iterations out of range");
    }
    // PBKDF2 (RFC 8018) with one block, since the key length equals the SHA-256 output.
    // Done by hand on raw UTF-8 bytes: PBEKeySpec takes a char[] whose byte encoding
    // differs between providers, and WebCrypto always uses the UTF-8 bytes.
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(passphrase.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    mac.update(salt);
    mac.update(new byte[] {0, 0, 0, 1});
    byte[] u = mac.doFinal();
    byte[] key = u.clone();
    for (int i = 1; i < iterations; i++) {
      mac.update(u);
      mac.doFinal(u, 0);
      for (int j = 0; j < key.length; j++) key[j] ^= u[j];
    }
    Arrays.fill(u, (byte) 0);
    return key;
  }

  public static byte[] randomIv() {
    byte[] iv = new byte[IV_BYTES];
    RANDOM.nextBytes(iv);
    return iv;
  }

  /** Never reuse an IV with the same key; callers outside tests use randomIv(). */
  public static byte[] encrypt(byte[] key, byte[] iv, byte[] plaintext, byte[] aad) throws GeneralSecurityException {
    return cipher(Cipher.ENCRYPT_MODE, key, iv, aad).doFinal(plaintext);
  }

  /** Throws AEADBadTagException when the key is wrong or the ciphertext was changed. */
  public static byte[] decrypt(byte[] key, byte[] iv, byte[] ciphertext, byte[] aad) throws GeneralSecurityException {
    return cipher(Cipher.DECRYPT_MODE, key, iv, aad).doFinal(ciphertext);
  }

  private static Cipher cipher(int mode, byte[] key, byte[] iv, byte[] aad) throws GeneralSecurityException {
    if (key == null || key.length != KEY_BYTES) throw new GeneralSecurityException("Invalid key length");
    if (iv == null || iv.length != IV_BYTES) throw new GeneralSecurityException("Invalid IV length");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(TAG_BITS, iv));
    cipher.updateAAD(aad);
    return cipher;
  }
}
