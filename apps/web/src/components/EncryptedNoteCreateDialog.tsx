import { useState, type FormEvent } from "react";
import { LoaderCircle, LockKeyhole, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ENCRYPTED_NOTE_MIN_PASSPHRASE_LENGTH } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  hasEncryptedNoteVaultVerifier,
  openEncryptedNoteVault,
  verifyEncryptedNoteVaultPassphrase,
} from "@/lib/encrypted-note-vault";

type Props = {
  open: boolean;
  scope: string;
  onOpenChange: (open: boolean) => void;
  /** Called once the vault session is open; the caller encrypts and creates the note. */
  onConfirmed: () => Promise<void>;
};

export const EncryptedNoteCreateDialog = ({ open, scope, onOpenChange, onConfirmed }: Props) => {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const knownVault = open && hasEncryptedNoteVaultVerifier(scope);

  const reset = () => {
    setPassphrase("");
    setConfirmation("");
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (passphrase.length < ENCRYPTED_NOTE_MIN_PASSPHRASE_LENGTH) {
      setError(t("encryptedNote.passphraseTooShort", { count: ENCRYPTED_NOTE_MIN_PASSPHRASE_LENGTH }));
      return;
    }
    if (!knownVault && passphrase !== confirmation) {
      setError(t("encryptedNote.passphraseMismatch"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (!(await verifyEncryptedNoteVaultPassphrase(scope, passphrase))) {
        setError(t("encryptedNote.vaultMismatch"));
        return;
      }
      await openEncryptedNoteVault(scope, passphrase);
      await onConfirmed();
      reset();
      onOpenChange(false);
    } catch {
      setError(t("encryptedNote.saveError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LockKeyhole className="h-4 w-4" aria-hidden="true" />
              {t("encryptedNote.createTitle")}
            </DialogTitle>
            <DialogDescription>{t("encryptedNote.createDescription")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="encrypted-note-passphrase">
              {t("encryptedNote.passphrase")}
            </label>
            <Input
              id="encrypted-note-passphrase"
              type="password"
              autoComplete={knownVault ? "current-password" : "new-password"}
              autoFocus
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              disabled={pending}
            />
            {!knownVault ? (
              <>
                <label className="text-sm font-medium text-slate-700" htmlFor="encrypted-note-passphrase-confirm">
                  {t("encryptedNote.confirmPassphrase")}
                </label>
                <Input
                  id="encrypted-note-passphrase-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={pending}
                />
                <p className="text-xs text-slate-500">{t("encryptedNote.firstPassphraseHint")}</p>
              </>
            ) : null}
          </div>
          <p className="flex gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {t("encryptedNote.lossWarning")} {t("encryptedNote.unsupportedFeatures")}
            </span>
          </p>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => { reset(); onOpenChange(false); }}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={pending || !passphrase}>
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {pending ? t("encryptedNote.creating") : t("encryptedNote.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
