import { ENCRYPTED_NOTE_AUTO_LOCK_MINUTE_OPTIONS, resolveEncryptedNoteAutoLockMinutes } from "@edgeever/shared";
import { LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { readEncryptedNoteAutoLockMinutes } from "@/lib/encrypted-note-auto-lock-preference";
import { setEncryptedNoteVaultAutoLockMinutes } from "@/lib/encrypted-note-vault";
import { secretBlocksSupported } from "@/lib/secret-blocks";
import { SETTINGS_ITEM_DESCRIPTION_CLASSNAME, SETTINGS_ITEM_TITLE_CLASSNAME } from "./settings-ui";

/** Fork: per-device vault settings, shown only when the server supports encrypted content. */
export const EncryptedNoteSettingsSection = () => {
  const { t } = useTranslation();
  const [autoLockMinutes, setAutoLockMinutes] = useState(readEncryptedNoteAutoLockMinutes);

  if (!secretBlocksSupported()) return null;

  return (
    <section className="grid gap-2">
      <h2 className="px-1 text-xs font-normal leading-5 text-slate-500">{t("encryptedNote.settingsGroup")}</h2>
      <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-card">
        <div className="flex min-h-16 flex-col items-start gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <LockKeyhole className="h-4 w-4 shrink-0 text-slate-500" />
            <div className="min-w-0">
              <div className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("encryptedNote.autoLockTitle")}</div>
              <div className={SETTINGS_ITEM_DESCRIPTION_CLASSNAME}>{t("encryptedNote.autoLockDescription")}</div>
            </div>
          </div>
          <div className="w-full shrink-0 sm:w-44">
            <Select
              value={String(autoLockMinutes)}
              onValueChange={(value) => {
                const next = resolveEncryptedNoteAutoLockMinutes(value);
                setEncryptedNoteVaultAutoLockMinutes(next);
                setAutoLockMinutes(next);
              }}
            >
              <SelectTrigger aria-label={t("encryptedNote.autoLockTitle")} className="h-9 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENCRYPTED_NOTE_AUTO_LOCK_MINUTE_OPTIONS.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {t("encryptedNote.autoLockOption", { count: minutes })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </section>
  );
};
