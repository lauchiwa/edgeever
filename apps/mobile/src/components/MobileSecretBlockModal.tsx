import { useEffect, useRef, useState } from "react";
import { AppState, Modal, ScrollView, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { SecretBlockAttributes } from "@edgeever/shared";
import { ActivityIndicator, Check, Copy, LockKeyhole, X } from "./icons";
import { Pressable, Text, TextInput } from "./LocalizedText";
import { EncryptedNoteWrongPassphraseError } from "../lib/encrypted-note-vault";
import { mobileEncryptedNoteVault as vault } from "../lib/mobile-encrypted-note-vault";

type Phase = "opening" | "locked" | "unlocking" | "shown";

/**
 * Fork: read-only native view of one inline secret block. The plaintext lives
 * only in this modal's state and is dropped on close, vault lock and app
 * background; it is never sent back to the editor WebView.
 */
export const MobileSecretBlockModal = ({
  block,
  locale,
  onClose,
  theme,
}: {
  block: SecretBlockAttributes | null;
  locale: "zh-CN" | "en-US" | "ja" | "pl" | "ru";
  onClose: () => void;
  theme: "light" | "dark";
}) => {
  const english = locale !== "zh-CN";
  const dark = theme === "dark";
  const [phase, setPhase] = useState<Phase>("opening");
  const [text, setText] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const envelope = block?.envelope ?? null;

  const reset = () => {
    setText(null);
    setPassphrase("");
    setError(null);
    setCopied(false);
  };

  // A new block opens with the session passphrase when the vault is unlocked.
  useEffect(() => {
    reset();
    if (!envelope) return;
    vault.expireIfIdle();
    if (!vault.isUnlocked()) {
      setPhase("locked");
      return;
    }
    let cancelled = false;
    setPhase("opening");
    void vault.decryptSecretBlock(envelope).then((plain) => {
      if (cancelled) return;
      if (plain === null) {
        setPhase("locked");
        return;
      }
      setText(plain);
      setPhase("shown");
    });
    return () => {
      cancelled = true;
    };
  }, [envelope]);

  // Locking (manual, idle timeout, sign-out) or leaving the app drops the plaintext.
  useEffect(() => vault.subscribe(() => {
    if (!vault.isUnlocked() || vault.isSealing()) onClose();
  }), [onClose]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") onClose();
    });
    return () => subscription.remove();
  }, [onClose]);
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const submitUnlock = async () => {
    if (!envelope || !passphrase || phase === "unlocking") return;
    setError(null);
    setPhase("unlocking");
    try {
      const plain = await vault.unlockSecretBlock(envelope, passphrase);
      setPassphrase("");
      setText(plain);
      setPhase("shown");
    } catch (unlockError) {
      setPhase("locked");
      setError(unlockError instanceof EncryptedNoteWrongPassphraseError
        ? (english ? "Wrong passphrase, or this block uses a different one." : "口令不正确，或这个加密块使用了其他口令。")
        : (english ? "This device could not decrypt the block." : "此设备无法解密这个加密块。"));
    }
  };

  const copy = async () => {
    if (text === null) return;
    try {
      await Clipboard.setStringAsync(text);
      vault.touch();
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(english ? "Could not copy to the clipboard." : "无法复制到剪贴板。");
    }
  };

  const unlocking = phase === "unlocking";
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={Boolean(block)}>
      <View style={styles.backdrop}>
        <View style={[styles.card, dark && styles.cardDark]}>
          <View style={styles.header}>
            <LockKeyhole color="#16A06E" size={18} />
            <Text numberOfLines={2} style={[styles.title, dark && styles.textDark]}>
              {block?.label || (english ? "Secret block" : "加密块")}
            </Text>
            <Pressable accessibilityLabel={english ? "Close" : "关闭"} accessibilityRole="button" hitSlop={8} onPress={onClose}>
              <X color={dark ? "#e2e8f0" : "#0f172a"} size={20} />
            </Pressable>
          </View>
          {phase === "shown" && text !== null ? (
            <>
              <ScrollView style={[styles.secretBox, dark && styles.secretBoxDark]}>
                <Text selectable style={[styles.secret, dark && styles.textDark]}>{text}</Text>
              </ScrollView>
              {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
              <Pressable accessibilityRole="button" onPress={() => void copy()} style={styles.button}>
                {copied ? <Check color="#ffffff" size={16} /> : <Copy color="#ffffff" size={16} />}
                <Text style={styles.buttonText}>{copied ? (english ? "Copied" : "已复制") : (english ? "Copy" : "复制")}</Text>
              </Pressable>
              <Text style={styles.hint}>{english ? "Read-only on this device. Edit secret blocks on Web or desktop." : "此设备上只读，请在 Web 或桌面端编辑加密块。"}</Text>
            </>
          ) : phase === "opening" ? (
            <ActivityIndicator color="#16A06E" size="small" />
          ) : (
            <>
              <Text style={styles.body}>
                {vault.wasAutoLocked()
                  ? (english ? "Locked after inactivity. Enter the vault passphrase to show this block." : "长时间未操作，已自动锁定，请输入保险库口令显示此加密块。")
                  : (english ? "Enter the vault passphrase to show this block." : "输入保险库口令后显示此加密块。")}
              </Text>
              <TextInput
                accessibilityLabel={english ? "Vault passphrase" : "保险库口令"}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                autoFocus
                editable={!unlocking}
                importantForAutofill="no"
                onChangeText={(value) => {
                  setPassphrase(value);
                  setError(null);
                }}
                onSubmitEditing={() => void submitUnlock()}
                placeholder={english ? "Vault passphrase" : "保险库口令"}
                placeholderTextColor="#94a3b8"
                returnKeyType="done"
                secureTextEntry
                style={[styles.input, dark && styles.inputDark]}
                textContentType="password"
                value={passphrase}
              />
              {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: unlocking, disabled: !passphrase || unlocking }}
                disabled={!passphrase || unlocking}
                onPress={() => void submitUnlock()}
                style={[styles.button, (!passphrase || unlocking) && styles.buttonDisabled]}
              >
                {unlocking ? <ActivityIndicator color="#ffffff" size="small" /> : null}
                <Text style={styles.buttonText}>{unlocking ? (english ? "Unlocking…" : "正在解锁…") : (english ? "Show" : "显示")}</Text>
              </Pressable>
              {unlocking ? <Text style={styles.hint}>{english ? "Deriving the key takes a few seconds." : "正在派生密钥，需要几秒钟。"}</Text> : null}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { alignItems: "center", backgroundColor: "rgba(15, 23, 42, 0.55)", flex: 1, justifyContent: "center", padding: 20 },
  card: { alignSelf: "stretch", backgroundColor: "#ffffff", borderRadius: 16, gap: 12, maxHeight: "80%", padding: 18 },
  cardDark: { backgroundColor: "#0f172a" },
  header: { alignItems: "center", flexDirection: "row", gap: 8 },
  title: { color: "#0f172a", flex: 1, fontSize: 16, fontWeight: "700" },
  textDark: { color: "#f8fafc" },
  body: { color: "#64748b", fontSize: 14, lineHeight: 20 },
  secretBox: { backgroundColor: "#f1f5f9", borderRadius: 10, flexGrow: 0, maxHeight: 320, padding: 12 },
  secretBoxDark: { backgroundColor: "#1e293b" },
  secret: { color: "#0f172a", fontFamily: "monospace", fontSize: 15, lineHeight: 22 },
  input: { borderColor: "#cbd5e1", borderRadius: 10, borderWidth: 1, color: "#0f172a", fontSize: 16, minHeight: 46, paddingHorizontal: 12 },
  inputDark: { borderColor: "#334155", color: "#f8fafc" },
  error: { color: "#b91c1c", fontSize: 13 },
  hint: { color: "#94a3b8", fontSize: 12 },
  button: { alignItems: "center", backgroundColor: "#16A06E", borderRadius: 10, flexDirection: "row", gap: 8, justifyContent: "center", minHeight: 46 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#ffffff", fontSize: 16, fontWeight: "700" },
});
