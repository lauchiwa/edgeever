import java.util.Base64;
import org.edgeever.crypto.EncryptedNoteCrypto;

/**
 * Test-only entry point: runs the Android crypto core on desktop Java so the
 * interop test can compare it with WebCrypto. Arguments and output are base64url,
 * which keeps non-ASCII passphrases intact across process boundaries.
 *
 *   derive  <passphrase> <salt> <iterations>   -> key
 *   encrypt <key> <iv> <plaintext> <aad>       -> ciphertext
 *   decrypt <key> <iv> <ciphertext> <aad>      -> plaintext (exit 3 on auth failure)
 */
public final class EncryptedNoteCryptoCli {
  private static byte[] in(String value) {
    return Base64.getUrlDecoder().decode(value);
  }

  private static void out(byte[] value) {
    System.out.print(Base64.getUrlEncoder().withoutPadding().encodeToString(value));
  }

  public static void main(String[] args) throws Exception {
    switch (args[0]) {
      case "derive":
        out(EncryptedNoteCrypto.deriveKey(new String(in(args[1]), "UTF-8"), in(args[2]), Integer.parseInt(args[3])));
        break;
      case "encrypt":
        out(EncryptedNoteCrypto.encrypt(in(args[1]), in(args[2]), in(args[3]), in(args[4])));
        break;
      case "decrypt":
        try {
          out(EncryptedNoteCrypto.decrypt(in(args[1]), in(args[2]), in(args[3]), in(args[4])));
        } catch (javax.crypto.AEADBadTagException error) {
          System.exit(3);
        }
        break;
      default:
        throw new IllegalArgumentException(args[0]);
    }
  }
}
