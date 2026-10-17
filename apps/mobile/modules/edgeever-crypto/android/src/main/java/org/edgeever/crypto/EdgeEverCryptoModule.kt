package org.edgeever.crypto

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// base64url without padding, the encoding of every field in an encrypted-note envelope.
private const val B64_FLAGS = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING

private fun decode(value: String): ByteArray = Base64.decode(value, B64_FLAGS)
private fun encode(value: ByteArray): String = Base64.encodeToString(value, B64_FLAGS)

class EdgeEverCryptoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("EdgeEverCrypto")

    // AsyncFunction runs off the JS thread, so 600k PBKDF2 rounds never block the UI.
    AsyncFunction("deriveKey") { passphrase: String, salt: String, iterations: Int ->
      encode(EncryptedNoteCrypto.deriveKey(passphrase, decode(salt), iterations))
    }

    // Plaintext is the payload JSON, sealed as UTF-8 exactly like WebCrypto's TextEncoder.
    AsyncFunction("encrypt") { key: String, plaintext: String, aad: String ->
      val iv = EncryptedNoteCrypto.randomIv()
      val ciphertext = EncryptedNoteCrypto.encrypt(
        decode(key), iv, plaintext.toByteArray(Charsets.UTF_8), aad.toByteArray(Charsets.UTF_8)
      )
      mapOf("iv" to encode(iv), "ct" to encode(ciphertext))
    }

    AsyncFunction("decrypt") { key: String, iv: String, ciphertext: String, aad: String ->
      String(
        EncryptedNoteCrypto.decrypt(decode(key), decode(iv), decode(ciphertext), aad.toByteArray(Charsets.UTF_8)),
        Charsets.UTF_8
      )
    }
  }
}
