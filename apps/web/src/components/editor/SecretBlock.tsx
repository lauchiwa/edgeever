import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Check, Copy, EyeOff, LoaderCircle, LockKeyhole, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SecretBlock as BaseSecretBlock,
  SECRET_BLOCK_LABEL_MAX_LENGTH,
  SECRET_BLOCK_NODE_TYPE,
  createSecretBlockId,
  isSecretBlockTextTooLarge,
  normalizeSecretBlockAttributes,
  normalizeSecretBlockLabel,
} from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  decryptSecretBlockWithVault,
  encryptSecretBlockWithVault,
  isEncryptedNoteVaultUnlocked,
  registerEncryptedNoteVaultFlush,
  subscribeEncryptedNoteVault,
  touchEncryptedNoteVault,
  unlockSecretBlock,
} from "@/lib/encrypted-note-vault";
import {
  forgetRevealedSecret,
  getSecretBlocksVaultScope,
  readRevealedSecret,
  rememberRevealedSecret,
  secretBlockRevealKey,
} from "@/lib/secret-blocks";

/** Keeps password managers, spellcheckers and writing extensions away from the plaintext. */
export const SECRET_TEXT_INPUT_PROPS = {
  spellCheck: false,
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  "data-gramm": "false",
  "data-gramm_editor": "false",
  "data-enable-grammarly": "false",
  "data-lt-active": "false",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
} as const;

const SecretBlockView = ({ node, editor, getPos, updateAttributes, selected }: NodeViewProps) => {
  const { t } = useTranslation();
  const attributes = normalizeSecretBlockAttributes(node.attrs);
  const revealKey = attributes ? secretBlockRevealKey(attributes.id, attributes.envelope.cipher.iv) : "";
  const unlocked = useSyncExternalStore(subscribeEncryptedNoteVault, isEncryptedNoteVaultUnlocked);
  const [text, setText] = useState<string | null>(() => (revealKey ? readRevealedSecret(revealKey) : null));
  const [askPassphrase, setAskPassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [draft, setDraft] = useState<{ label: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const shownKeyRef = useRef(revealKey);

  // The envelope is the source of truth: a change from elsewhere (sync, undo) relocks the block.
  useEffect(() => {
    if (shownKeyRef.current === revealKey) return;
    shownKeyRef.current = revealKey;
    setText(revealKey ? readRevealedSecret(revealKey) : null);
    setDraft(null);
    setError(null);
  }, [revealKey]);

  // Locking the vault (manually or after inactivity) drops every plaintext copy.
  useEffect(() => {
    if (unlocked) return;
    setText(null);
    setDraft(null);
  }, [unlocked]);

  // An open draft is sealed into the note before the vault locks, as if "Done" was pressed.
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const hasDraft = draft !== null;
  useEffect(() => (hasDraft ? registerEncryptedNoteVaultFlush(() => saveRef.current()) : undefined), [hasDraft]);

  if (!attributes) {
    return <NodeViewWrapper contentEditable={false} className="edgeever-secret-block my-3 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500">{t("secretBlock.damaged")}</NodeViewWrapper>;
  }
  const label = attributes.label || t("secretBlock.defaultLabel");
  const editable = editor.isEditable;

  const show = (next: string) => {
    rememberRevealedSecret(revealKey, next);
    setText(next);
    setAskPassphrase(false);
    setPassphrase("");
  };

  const reveal = async () => {
    setError(null);
    if (!isEncryptedNoteVaultUnlocked()) {
      setAskPassphrase(true);
      return;
    }
    setBusy(true);
    const next = await decryptSecretBlockWithVault(attributes.envelope);
    setBusy(false);
    if (next === null) setAskPassphrase(true);
    else show(next);
  };

  const submitPassphrase = async (event: FormEvent) => {
    event.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      show(await unlockSecretBlock(getSecretBlocksVaultScope(), attributes.envelope, passphrase));
    } catch {
      setError(t("encryptedNote.wrongPassphrase"));
    } finally {
      setBusy(false);
    }
  };

  const hide = () => {
    forgetRevealedSecret(revealKey);
    setText(null);
    setDraft(null);
  };

  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t("secretBlock.copyError"));
    }
  };

  const startEditing = () => {
    if (text === null || !editor.isEditable) return;
    setError(null);
    setDraft({ label: attributes.label, text });
  };

  const save = async () => {
    if (!draft || busy || text === null) return;
    const nextLabel = normalizeSecretBlockLabel(draft.label);
    if (draft.text === text) {
      if (nextLabel !== attributes.label) updateAttributes({ label: nextLabel });
      setDraft(null);
      return;
    }
    if (isSecretBlockTextTooLarge(draft.text)) {
      setError(t("secretBlock.tooLarge"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Only a changed secret is re-encrypted; the note's block salt keeps PBKDF2 cached.
      const envelope = await encryptSecretBlockWithVault(draft.text, attributes.envelope.kdf);
      const nextKey = secretBlockRevealKey(attributes.id, envelope.cipher.iv);
      forgetRevealedSecret(revealKey);
      rememberRevealedSecret(nextKey, draft.text);
      shownKeyRef.current = nextKey;
      setText(draft.text);
      setDraft(null);
      updateAttributes({ label: nextLabel, envelope });
    } catch {
      setError(isEncryptedNoteVaultUnlocked() ? t("secretBlock.saveError") : t("encryptedNote.autoLocked"));
    } finally {
      setBusy(false);
    }
  };

  const changeDraft = (next: { label: string; text: string }) => {
    setDraft(next);
    touchEncryptedNoteVault();
  };

  saveRef.current = save;

  const onDraftKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft(null);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <NodeViewWrapper
      contentEditable={false}
      data-secret-block-id={attributes.id}
      className={`edgeever-secret-block not-prose my-3 rounded-lg border bg-slate-50 px-3 py-2 ${selected ? "border-slate-500 ring-1 ring-slate-400" : "border-slate-200"}`}
    >
      <div className="flex min-h-8 flex-wrap items-center gap-2" data-drag-handle>
        <LockKeyhole className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{label}</span>
        {text !== null && !draft ? (
          <div className="flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => void copy()}>
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
              {copied ? t("secretBlock.copied") : t("secretBlock.copy")}
            </Button>
            {editable ? (
              <Button type="button" size="sm" variant="ghost" onClick={startEditing}>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                {t("secretBlock.edit")}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={hide}>
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
              {t("secretBlock.hide")}
            </Button>
          </div>
        ) : null}
        {text === null && !askPassphrase ? (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void reveal()}>
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {t("secretBlock.show")}
          </Button>
        ) : null}
      </div>
      {text === null && askPassphrase ? (
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => void submitPassphrase(event)}>
          <label className="sr-only" htmlFor={`secret-block-passphrase-${attributes.id}`}>{t("encryptedNote.passphrase")}</label>
          <Input
            id={`secret-block-passphrase-${attributes.id}`}
            type="password"
            autoComplete="current-password"
            autoFocus
            className="h-8 min-w-0 flex-1"
            placeholder={t("encryptedNote.passphrase")}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            disabled={busy}
          />
          <Button type="submit" size="sm" disabled={!passphrase || busy}>
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {t("encryptedNote.unlock")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setAskPassphrase(false); setPassphrase(""); setError(null); }}>
            {t("common.cancel")}
          </Button>
        </form>
      ) : null}
      {draft ? (
        <div className="mt-2 grid gap-2">
          <Input
            aria-label={t("secretBlock.label")}
            placeholder={t("secretBlock.labelPlaceholder")}
            maxLength={SECRET_BLOCK_LABEL_MAX_LENGTH}
            value={draft.label}
            onChange={(event) => changeDraft({ ...draft, label: event.target.value })}
            onKeyDown={onDraftKeyDown}
            disabled={busy}
          />
          <Textarea
            {...SECRET_TEXT_INPUT_PROPS}
            aria-label={t("secretBlock.secret")}
            autoFocus
            rows={Math.min(12, Math.max(3, draft.text.split("\n").length + 1))}
            className="font-mono"
            value={draft.text}
            onChange={(event) => changeDraft({ ...draft, text: event.target.value })}
            onKeyDown={onDraftKeyDown}
            disabled={busy}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t("common.cancel")}</Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              {t("secretBlock.done")}
            </Button>
          </div>
        </div>
      ) : text !== null ? (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-card px-3 py-2 font-mono text-sm text-slate-800">{text || " "}</pre>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </NodeViewWrapper>
  );
};

const secretBlockIdsKey = new PluginKey("edgeever-secret-block-ids");

/**
 * Editor variant of the secret block: React view, and HTML that carries the
 * envelope so copy and paste inside EdgeEver keeps the ciphertext. A pasted
 * copy gets a fresh id; the envelope does not depend on it.
 */
export const SecretBlock = BaseSecretBlock.extend({
  addAttributes() {
    const parent: Record<string, Record<string, unknown>> = this.parent?.() ?? {};
    return {
      ...parent,
      envelope: {
        ...parent.envelope,
        rendered: true,
        renderHTML: (attrs: Record<string, unknown>) => (
          attrs.envelope ? { "data-secret-envelope": JSON.stringify(attrs.envelope) } : {}
        ),
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(SecretBlockView);
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      key: secretBlockIdsKey,
      appendTransaction: (transactions, _oldState, newState) => {
        if (!transactions.some((tr) => tr.docChanged && (tr.getMeta("paste") || tr.getMeta("uiEvent") === "drop"))) return null;
        const seen = new Set<string>();
        const tr = newState.tr;
        newState.doc.descendants((node, pos) => {
          if (node.type.name !== SECRET_BLOCK_NODE_TYPE) return;
          const id = String(node.attrs.id ?? "");
          if (seen.has(id)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: createSecretBlockId() });
          else seen.add(id);
          return false;
        });
        return tr.docChanged ? tr : null;
      },
    })];
  },
});
