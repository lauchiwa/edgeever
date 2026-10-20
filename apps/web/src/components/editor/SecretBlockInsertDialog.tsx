import { useState, type FormEvent } from "react";
import type { Editor } from "@tiptap/core";
import { LoaderCircle, LockKeyhole, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ENCRYPTED_NOTE_MIN_PASSPHRASE_LENGTH,
  SECRET_BLOCK_LABEL_MAX_LENGTH,
  SECRET_BLOCK_NODE_TYPE,
  createSecretBlockId,
  findSecretBlockKdf,
  isSecretBlockTextTooLarge,
  normalizeSecretBlockLabel,
  type TiptapDoc,
} from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  encryptSecretBlockWithVault,
  hasEncryptedNoteVaultVerifier,
  isEncryptedNoteVaultUnlocked,
  openEncryptedNoteVault,
  verifyEncryptedNoteVaultPassphrase,
} from "@/lib/encrypted-note-vault";
import { getSecretBlocksVaultScope, rememberRevealedSecret, secretBlockRevealKey } from "@/lib/secret-blocks";
import { SECRET_TEXT_INPUT_PROPS } from "./SecretBlock";

type Props = {
  editor: Editor | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Encrypts first, then inserts: the document never holds an empty or unsealed secret block. */
export const SecretBlockInsertDialog = ({ editor, open, onOpenChange }: Props) => {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const scope = getSecretBlocksVaultScope();
  const needsPassphrase = open && !isEncryptedNoteVaultUnlocked();
  const knownVault = open && hasEncryptedNoteVaultVerifier(scope);

  const close = () => {
    setLabel("");
    setText("");
    setPassphrase("");
    setConfirmation("");
    setError(null);
    onOpenChange(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !editor || !text) return;
    if (isSecretBlockTextTooLarge(text)) {
      setError(t("secretBlock.tooLarge"));
      return;
    }
    if (needsPassphrase) {
      if (passphrase.length < ENCRYPTED_NOTE_MIN_PASSPHRASE_LENGTH) {
        setError(t("encryptedNote.passphraseTooShort", { count: ENCRYPTED_NOTE_MIN_PASSPHRASE_LENGTH }));
        return;
      }
      if (!knownVault && passphrase !== confirmation) {
        setError(t("encryptedNote.passphraseMismatch"));
        return;
      }
    }
    setPending(true);
    setError(null);
    try {
      if (needsPassphrase) {
        if (!(await verifyEncryptedNoteVaultPassphrase(scope, passphrase))) {
          setError(t("encryptedNote.vaultMismatch"));
          return;
        }
        await openEncryptedNoteVault(scope, passphrase);
      }
      // All blocks in a note share one salt, so the key is derived once per note.
      const envelope = await encryptSecretBlockWithVault(text, findSecretBlockKdf(editor.getJSON() as TiptapDoc));
      const id = createSecretBlockId();
      rememberRevealedSecret(secretBlockRevealKey(id, envelope.cipher.iv), text);
      editor.chain().focus().insertContent({
        type: SECRET_BLOCK_NODE_TYPE,
        attrs: { id, label: normalizeSecretBlockLabel(label), envelope },
      }).run();
      close();
    } catch {
      setError(t("secretBlock.saveError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending && !next) close(); }}>
      <DialogContent className="max-w-md">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LockKeyhole className="h-4 w-4" aria-hidden="true" />
              {t("secretBlock.insertTitle")}
            </DialogTitle>
            <DialogDescription>{t("secretBlock.insertDescription")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="secret-block-label">{t("secretBlock.label")}</label>
            <Input
              id="secret-block-label"
              placeholder={t("secretBlock.labelPlaceholder")}
              maxLength={SECRET_BLOCK_LABEL_MAX_LENGTH}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              disabled={pending}
            />
            <label className="text-sm font-medium text-slate-700" htmlFor="secret-block-text">{t("secretBlock.secret")}</label>
            <Textarea
              {...SECRET_TEXT_INPUT_PROPS}
              id="secret-block-text"
              autoFocus
              rows={4}
              className="font-mono"
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={pending}
            />
            {needsPassphrase ? (
              <>
                <label className="text-sm font-medium text-slate-700" htmlFor="secret-block-passphrase">{t("encryptedNote.passphrase")}</label>
                <Input
                  id="secret-block-passphrase"
                  type="password"
                  autoComplete={knownVault ? "current-password" : "new-password"}
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  disabled={pending}
                />
                {!knownVault ? (
                  <>
                    <label className="text-sm font-medium text-slate-700" htmlFor="secret-block-passphrase-confirm">{t("encryptedNote.confirmPassphrase")}</label>
                    <Input
                      id="secret-block-passphrase-confirm"
                      type="password"
                      autoComplete="new-password"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      disabled={pending}
                    />
                    <p className="text-xs text-slate-500">{t("encryptedNote.firstPassphraseHint")}</p>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
          <p className="flex gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t("encryptedNote.lossWarning")} {t("secretBlock.labelVisible")}</span>
          </p>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={close}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={pending || !text || (needsPassphrase && !passphrase)}>
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {pending ? t("encryptedNote.creating") : t("secretBlock.insert")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
