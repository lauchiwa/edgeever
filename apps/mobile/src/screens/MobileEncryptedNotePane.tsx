import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Keyboard, StyleSheet, View } from "react-native";
import { parseEncryptedNoteEnvelope, type MemoDetail, type TiptapDoc } from "@edgeever/shared";
import { ActivityIndicator, LockKeyhole } from "../components/icons";
import { Pressable, Text, TextInput } from "../components/LocalizedText";
import MobileEncryptedNoteEditor from "../components/MobileEncryptedNoteEditor";
import type { MobileMemoUpdateMutation } from "../hooks/useMobileRichEditor";
import { SAFE_DOM_WEBVIEW_PROPS } from "../lib/mobile-dom";
import { EncryptedNoteWrongPassphraseError } from "../lib/encrypted-note-vault";
import { mobileEncryptedNoteVault as vault } from "../lib/mobile-encrypted-note-vault";
import { shouldReloadEncryptedNote } from "../lib/mobile-encrypted-note";

const SAVE_DEBOUNCE_MS = 800;

const lostEditsMessage = (english: boolean) => english
  ? "The vault locked before your last changes could be saved. Unlock to continue from the last saved version."
  : "保险库在最后的修改保存前已锁定，解锁后将从上次保存的版本继续。";

type Phase = "locked" | "unlocking" | "ready" | "invalid";
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

/**
 * Body of an encrypted note: passphrase prompt while locked, decrypted editor
 * when unlocked. Plaintext lives only in this component's state and the editor
 * WebView; every save goes out as a new ciphertext envelope through the normal
 * update mutation (online first, durable outbox otherwise), so drafts, the
 * local mirror and the outbox only ever hold ciphertext.
 */
export const MobileEncryptedNotePane = ({
  locale,
  memo,
  readOnly,
  theme,
  updateMutation,
}: {
  locale: "zh-CN" | "en-US" | "ja" | "pl";
  memo: MemoDetail;
  readOnly: boolean;
  theme: "light" | "dark";
  updateMutation: MobileMemoUpdateMutation;
}) => {
  const english = locale !== "zh-CN";
  const englishRef = useRef(english);
  englishRef.current = english;
  // While a lock saves open edits the plaintext is already covered and read-only.
  const sealing = useSyncExternalStore(vault.subscribe, vault.isSealing);
  const envelope = useMemo(() => parseEncryptedNoteEnvelope(memo.contentMarkdown), [memo.contentMarkdown]);
  const [phase, setPhase] = useState<Phase>(envelope ? "locked" : "invalid");
  const [doc, setDoc] = useState<TiptapDoc | null>(null);
  const [generation, setGeneration] = useState(0);
  const [passphrase, setPassphrase] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [contentError, setContentError] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState(false);

  const memoRef = useRef(memo);
  memoRef.current = memo;
  const updateRef = useRef(updateMutation);
  updateRef.current = updateMutation;
  const mountedRef = useRef(true);
  const pendingDocRef = useRef<TiptapDoc | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef<Promise<void> | null>(null);
  // Envelopes this pane decrypted or wrote, and the newest revision it has seen:
  // our own saves coming back from sync must not reload the editor.
  const knownMarkdownRef = useRef(new Set<string>());
  const seenRevisionRef = useRef(memo.revision);

  const setSaveStateSafe = (next: SaveState) => {
    if (mountedRef.current) setSaveState(next);
  };

  const save = useCallback(async (): Promise<void> => {
    if (savingRef.current) {
      await savingRef.current;
      if (pendingDocRef.current) await save();
      return;
    }
    const next = pendingDocRef.current;
    const current = memoRef.current;
    const kdf = parseEncryptedNoteEnvelope(current.contentMarkdown)?.kdf;
    if (!next || !kdf) return;
    pendingDocRef.current = null;
    const run = (async () => {
      setSaveStateSafe("saving");
      try {
        const { contentMarkdown } = await vault.encrypt(next, kdf);
        knownMarkdownRef.current.add(contentMarkdown);
        // contentJson stays a placeholder: the server forces it anyway, and the
        // optimistic local copy must not carry the plaintext document.
        await updateRef.current.mutateAsync({ memo: current, payload: { contentMarkdown } });
        setSaveStateSafe(pendingDocRef.current ? "pending" : "saved");
      } catch {
        if (vault.isUnlocked()) {
          // Keep the edit so the next change or flush retries it.
          pendingDocRef.current ??= next;
          setSaveStateSafe("error");
        } else if (mountedRef.current) {
          // The lock already dropped the key: this edit cannot be sealed any more.
          setUnlockError(lostEditsMessage(englishRef.current));
        }
      }
    })();
    savingRef.current = run;
    try {
      await run;
    } finally {
      savingRef.current = null;
    }
  }, []);

  const flush = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (pendingDocRef.current || savingRef.current) await save();
  }, [save]);

  const showDoc = useCallback((next: TiptapDoc, markdown: string) => {
    knownMarkdownRef.current.add(markdown);
    setDoc(next);
    setContentError(false);
    setGeneration((value) => value + 1);
    setPhase("ready");
  }, []);

  // Open with the session passphrase when the vault is already unlocked.
  useEffect(() => {
    if (!envelope || phase !== "locked" || !vault.isUnlocked()) return;
    let cancelled = false;
    void vault.decrypt(envelope).then((decrypted) => {
      if (!cancelled && decrypted) showDoc(decrypted, memoRef.current.contentMarkdown);
    });
    return () => {
      cancelled = true;
    };
  }, [envelope, phase, showDoc]);

  // Reload only for a newer revision written elsewhere, and never over unsaved edits.
  useEffect(() => {
    if (!envelope || phase !== "ready") return;
    const reload = shouldReloadEncryptedNote({
      contentMarkdown: memo.contentMarkdown,
      revision: memo.revision,
      seenRevision: seenRevisionRef.current,
      known: knownMarkdownRef.current,
      hasUnsavedChanges: Boolean(pendingDocRef.current || savingRef.current),
    });
    seenRevisionRef.current = Math.max(seenRevisionRef.current, memo.revision);
    if (!reload) return;
    let cancelled = false;
    void vault.decrypt(envelope).then((decrypted) => {
      if (cancelled) return;
      if (decrypted) showDoc(decrypted, memo.contentMarkdown);
      else setPhase("locked");
    });
    return () => {
      cancelled = true;
    };
  }, [envelope, memo.contentMarkdown, memo.revision, phase, showDoc]);

  // An idle lock saves pending edits first, while the key is still cached.
  useEffect(() => vault.registerFlush(flush), [flush]);

  // Locking (manual, idle timeout, sign-out) drops the plaintext, including edits
  // that could not be saved: they cannot be encrypted any more. A save still in
  // flight reports for itself when it settles.
  useEffect(() => vault.subscribe(() => {
    if (vault.isSealing()) Keyboard.dismiss();
    if (vault.isUnlocked()) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const lostEdits = pendingDocRef.current !== null;
    pendingDocRef.current = null;
    if (lostEdits && mountedRef.current) setUnlockError(lostEditsMessage(englishRef.current));
    setDoc(null);
    setPhase((current) => (current === "invalid" ? current : "locked"));
  }), []);

  // JS timers pause in the background; re-check the idle timeout on return.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") vault.expireIfIdle();
    });
    return () => subscription.remove();
  }, []);

  // Closing the note finishes the last save; the mutation outlives this screen.
  useEffect(() => () => {
    mountedRef.current = false;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (pendingDocRef.current) void save();
  }, [save]);

  const submitUnlock = async () => {
    if (!envelope || !passphrase || phase === "unlocking") return;
    setUnlockError(null);
    setPhase("unlocking");
    try {
      const decrypted = await vault.unlock(envelope, passphrase);
      setPassphrase("");
      showDoc(decrypted, memo.contentMarkdown);
    } catch (error) {
      setPhase("locked");
      setUnlockError(error instanceof EncryptedNoteWrongPassphraseError
        ? (english ? "Wrong passphrase, or this note uses a different one." : "口令不正确，或这篇笔记使用了其他口令。")
        : (english ? "This device could not decrypt the note." : "此设备无法解密这篇笔记。"));
    }
  };

  const onChange = useCallback(async (next: TiptapDoc) => {
    pendingDocRef.current = next;
    vault.touch();
    setSaveState("pending");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void save();
    }, SAVE_DEBOUNCE_MS);
  }, [save]);

  const lockNow = () => vault.flushAndLock();

  const dom = useMemo(() => ({
    ...SAFE_DOM_WEBVIEW_PROPS,
    overScrollMode: "never" as const,
    scrollEnabled: false,
    style: [paneStyles.editor, theme === "dark" ? paneStyles.editorDark : null],
  }), [theme]);

  if (phase === "invalid") {
    return (
      <View style={paneStyles.center}>
        <LockKeyhole color="#64748b" size={28} />
        <Text style={paneStyles.title}>{english ? "This encrypted note is damaged" : "这篇加密笔记已损坏"}</Text>
        <Text style={paneStyles.body}>{english ? "Its encrypted content cannot be read on any device." : "加密内容无法读取，任何设备都无法打开。"}</Text>
      </View>
    );
  }

  if (phase !== "ready" || !doc) {
    const unlocking = phase === "unlocking";
    return (
      <View style={paneStyles.center}>
        <LockKeyhole color="#16A06E" size={28} />
        <Text style={paneStyles.title}>{english ? "Encrypted note" : "加密笔记"}</Text>
        <Text style={paneStyles.body}>
          {vault.wasAutoLocked()
            ? (english ? "Locked after inactivity. Enter the vault passphrase to continue." : "长时间未操作，已自动锁定，请输入保险库口令继续。")
            : (english ? "Enter the vault passphrase to read and edit this note." : "输入保险库口令后即可阅读和编辑这篇笔记。")}
        </Text>
        <TextInput
          accessibilityLabel={english ? "Vault passphrase" : "保险库口令"}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          editable={!unlocking}
          importantForAutofill="no"
          onChangeText={(value) => {
            setPassphrase(value);
            setUnlockError(null);
          }}
          onSubmitEditing={() => void submitUnlock()}
          placeholder={english ? "Vault passphrase" : "保险库口令"}
          placeholderTextColor="#94a3b8"
          returnKeyType="done"
          secureTextEntry
          style={[paneStyles.input, theme === "dark" && paneStyles.inputDark]}
          textContentType="password"
          value={passphrase}
        />
        {unlockError ? <Text accessibilityLiveRegion="polite" style={paneStyles.error}>{unlockError}</Text> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: unlocking, disabled: !passphrase || unlocking }}
          disabled={!passphrase || unlocking}
          onPress={() => void submitUnlock()}
          style={[paneStyles.button, (!passphrase || unlocking) && paneStyles.buttonDisabled]}
        >
          {unlocking ? <ActivityIndicator color="#ffffff" size="small" /> : null}
          <Text style={paneStyles.buttonText}>{unlocking ? (english ? "Unlocking…" : "正在解锁…") : (english ? "Unlock" : "解锁")}</Text>
        </Pressable>
        {unlocking ? <Text style={paneStyles.hint}>{english ? "Deriving the key takes a few seconds." : "正在派生密钥，需要几秒钟。"}</Text> : null}
      </View>
    );
  }

  const saveLabel = saveState === "saving" || saveState === "pending"
    ? (english ? "Saving…" : "保存中…")
    : saveState === "error"
      ? (english ? "Not saved, will retry" : "未保存，将重试")
      : saveState === "saved"
        ? (english ? "Encrypted and saved" : "已加密保存")
        : (english ? "Encrypted" : "已加密");
  const editable = !readOnly && !contentError && !sealing;

  return (
    <View style={paneStyles.root}>
      <View style={paneStyles.bar}>
        <LockKeyhole color="#16A06E" size={14} />
        <Text accessibilityLiveRegion="polite" numberOfLines={1} style={[paneStyles.barText, saveState === "error" && paneStyles.error]}>{saveLabel}</Text>
        <Pressable
          accessibilityLabel={english ? "Lock encrypted notes" : "锁定加密笔记"}
          accessibilityRole="button"
          accessibilityState={{ disabled: sealing }}
          disabled={sealing}
          hitSlop={6}
          onPress={() => void lockNow()}
          style={paneStyles.lockButton}
        >
          <Text style={paneStyles.lockButtonText}>{english ? "Lock" : "锁定"}</Text>
        </Pressable>
      </View>
      {contentError ? (
        <Text style={paneStyles.notice}>{english ? "This note contains content the phone editor cannot show safely. It is read-only here; edit it on Web or desktop." : "这篇笔记包含手机端无法安全显示的内容，此处只读，请在 Web 或桌面端编辑。"}</Text>
      ) : null}
      {attachmentNotice ? (
        <Text style={paneStyles.notice}>{english ? "Images and attachments cannot be added to encrypted notes." : "加密笔记不支持插入图片或附件。"}</Text>
      ) : null}
      <MobileEncryptedNoteEditor
        content={doc}
        dom={dom}
        editable={editable}
        key={`${memo.id}:${generation}`}
        locale={locale}
        onAttachmentBlocked={async () => setAttachmentNotice(true)}
        onChange={onChange}
        onContentError={async () => setContentError(true)}
        theme={theme}
      />
      {sealing ? (
        // Covers the editor without unmounting it, so its last change still reaches the save.
        <View accessibilityLiveRegion="polite" style={[paneStyles.sealing, theme === "dark" && paneStyles.sealingDark]}>
          <ActivityIndicator color="#16A06E" size="small" />
          <Text style={paneStyles.body}>{english ? "Saving and locking…" : "正在保存并锁定…"}</Text>
        </View>
      ) : null}
    </View>
  );
};

const paneStyles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  center: { flex: 1, alignItems: "center", gap: 10, paddingHorizontal: 28, paddingTop: 48 },
  title: { color: "#0f172a", fontSize: 17, fontWeight: "700" },
  body: { color: "#64748b", fontSize: 14, lineHeight: 20, textAlign: "center" },
  input: {
    alignSelf: "stretch",
    borderColor: "#cbd5e1",
    borderRadius: 10,
    borderWidth: 1,
    color: "#0f172a",
    fontSize: 16,
    marginTop: 6,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  inputDark: { borderColor: "#334155", color: "#f8fafc" },
  error: { color: "#b91c1c", fontSize: 13 },
  hint: { color: "#94a3b8", fontSize: 12 },
  button: {
    alignItems: "center",
    alignSelf: "stretch",
    backgroundColor: "#16A06E",
    borderRadius: 10,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 46,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#ffffff", fontSize: 16, fontWeight: "700" },
  bar: { alignItems: "center", flexDirection: "row", gap: 6, paddingHorizontal: 16, paddingVertical: 6 },
  barText: { color: "#64748b", flex: 1, fontSize: 12 },
  lockButton: { borderColor: "#cbd5e1", borderRadius: 999, borderWidth: 1, minHeight: 28, justifyContent: "center", paddingHorizontal: 12 },
  lockButtonText: { color: "#0f172a", fontSize: 13, fontWeight: "600" },
  notice: { color: "#92400e", fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingBottom: 6 },
  editor: { backgroundColor: "#ffffff", flex: 1, minHeight: 0 },
  editorDark: { backgroundColor: "#0f172a" },
  sealing: { ...StyleSheet.absoluteFill, alignItems: "center", backgroundColor: "#ffffff", gap: 10, justifyContent: "center" },
  sealingDark: { backgroundColor: "#0f172a" },
});
