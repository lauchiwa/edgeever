import "katex/dist/katex.min.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Check, ChevronLeft, LoaderCircle, Lock, LockKeyhole, Pencil } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslation } from "react-i18next";
import {
  createEdgeEverDocumentExtensions,
  encryptedNotePlaceholderDoc,
  parseEncryptedNoteEnvelope,
  type MemoDetail,
  type MemoEditSession,
  type Notebook,
  type TiptapDoc,
} from "@edgeever/shared";
import { EdgeEverLink } from "@edgeever/shared/editor-link";
import { createEdgeEverMathematics } from "@edgeever/shared/mathematics";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { IconTooltip } from "@/components/editor/EditorPaneChrome";
import { createLocalEditSession, requiresLocalEditSession } from "@/components/editor/editor-pane-helpers";
import { MemoEditorHeaderActions } from "@/components/MemoEditorHeaderActions";
import { MemoEditorMetadataRow } from "@/components/MemoEditorMetadataRow";
import { MemoEditorFocusModeButton, MemoEditorTopRowLeading } from "@/components/MemoEditorTopRowLeading";
import { MEMO_EDITOR_METADATA_ROW_CLASS_NAME, MEMO_EDITOR_TOP_ROW_CLASS_NAME, nextTitleStatusClearance } from "@/components/MemoEditorChromeDensity";
import { MemoEditorToolbarDivider } from "@/components/MemoEditorToolbarChrome";
import { MemoTitleInput } from "@/components/MemoTitleInput";
import { api } from "@/lib/api";
import { getNotebookMoveOptions } from "@/lib/app-helpers";
import { EdgeEverCodeBlock, codeBlockLowlight } from "@/lib/code-block";
import {
  decryptWithEncryptedNoteVault,
  encryptWithEncryptedNoteVault,
  flushAndLockEncryptedNoteVault,
  isEncryptedNoteVaultUnlocked,
  registerEncryptedNoteVaultFlush,
  subscribeEncryptedNoteVault,
  touchEncryptedNoteVault,
  unlockEncryptedNote,
  wasEncryptedNoteVaultAutoLocked,
} from "@/lib/encrypted-note-vault";
import { statusSettleMotion } from "@/lib/motion";
import type { EdgeEverRepository } from "@/lib/repository";
import { cn, parseTagsText } from "@/lib/utils";

type Props = {
  memo: MemoDetail;
  notebooks: Notebook[];
  repository: EdgeEverRepository;
  scope: string;
  readOnly: boolean;
  desktopFocusMode: boolean;
  onBackToList: () => void;
  onOpenExecutionCenter: () => void;
  onSaved: (memo: MemoDetail) => Promise<void>;
  onToggleDesktopFocusMode: () => void;
};

const hasFiles = (data: DataTransfer | null) => Boolean(data && Array.from(data.items ?? []).some((item) => item.kind === "file"));

/**
 * Decrypted editor. Attachments are deliberately not in the schema: an image
 * or file would be uploaded as plaintext, so paste/drop of files is refused.
 */
const EncryptedNoteEditor = ({
  doc,
  editable,
  onChange,
  onContentError,
  onAttachmentBlocked,
}: {
  doc: TiptapDoc;
  editable: boolean;
  onChange: (doc: TiptapDoc) => void;
  onContentError: () => void;
  onAttachmentBlocked: () => void;
}) => {
  const callbacks = useRef({ onChange, onContentError, onAttachmentBlocked });
  callbacks.current = { onChange, onContentError, onAttachmentBlocked };
  const mathematics = useMemo(() => createEdgeEverMathematics(), []);
  const editor = useEditor({
    extensions: [
      ...createEdgeEverDocumentExtensions({
        mathematics,
        starterKit: { codeBlock: false, link: false },
        image: false,
        gallery: false,
        pdf: false,
        file: false,
        pluginEmbed: false,
        table: { table: { renderWrapper: true } },
      }),
      EdgeEverLink.configure({ openOnClick: false }),
      EdgeEverCodeBlock.configure({ lowlight: codeBlockLowlight, defaultLanguage: "plaintext" }),
    ],
    content: doc,
    editable,
    // Never let an unknown node silently load as an empty document that autosave would persist.
    enableContentCheck: true,
    onContentError: ({ disableCollaboration }) => {
      disableCollaboration();
      callbacks.current.onContentError();
    },
    onUpdate: ({ editor: current }) => callbacks.current.onChange(current.getJSON() as TiptapDoc),
    editorProps: {
      attributes: {
        class: "edgeever-note-rich-editor prose prose-slate max-w-none focus:outline-none min-h-[240px]",
        "aria-label": "Encrypted note content",
        // Keeps spellcheck services and writing extensions away from the plaintext, like secret blocks.
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
        "data-gramm": "false",
        "data-gramm_editor": "false",
        "data-enable-grammarly": "false",
        "data-lt-active": "false",
      },
      handlePaste: (_view, event) => {
        if (!hasFiles(event.clipboardData)) return false;
        callbacks.current.onAttachmentBlocked();
        return true;
      },
      handleDrop: (_view, event) => {
        if (!hasFiles((event as DragEvent).dataTransfer)) return false;
        callbacks.current.onAttachmentBlocked();
        return true;
      },
    },
  }, []);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  return <EditorContent editor={editor} />;
};

export default function EncryptedNotePane({
  memo,
  notebooks,
  repository,
  scope,
  readOnly,
  desktopFocusMode,
  onBackToList,
  onOpenExecutionCenter,
  onSaved,
  onToggleDesktopFocusMode,
}: Props) {
  const { t } = useTranslation();
  const unlocked = useSyncExternalStore(subscribeEncryptedNoteVault, isEncryptedNoteVaultUnlocked);
  const envelope = useMemo(() => parseEncryptedNoteEnvelope(memo.contentMarkdown), [memo.contentMarkdown]);
  const [doc, setDoc] = useState<TiptapDoc | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [title, setTitle] = useState(memo.title ?? "");
  const [tagsText, setTagsText] = useState(memo.tags.join(", "));
  const [passphrase, setPassphrase] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [contentError, setContentError] = useState(false);
  const [sessionNonce, setSessionNonce] = useState(0);
  const [mobileNotebookSheetOpen, setMobileNotebookSheetOpen] = useState(false);
  const [notebookUpdatePending, setNotebookUpdatePending] = useState(false);
  const [headerTitleSlot, setHeaderTitleSlot] = useState<HTMLDivElement | null>(null);
  const [headerStatusCluster, setHeaderStatusCluster] = useState<HTMLDivElement | null>(null);
  const [titleStatusClearancePx, setTitleStatusClearancePx] = useState(0);
  const memoRef = useRef(memo);
  const sessionRef = useRef<MemoEditSession | null>(null);
  const docRef = useRef<TiptapDoc | null>(null);
  const editVersionRef = useRef(0);
  const savedMarkdownRef = useRef(memo.contentMarkdown);
  const dirtyRef = useRef(false);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  // The in-flight save, so a flush before locking waits for it instead of skipping.
  const savingRef = useRef<Promise<boolean> | null>(null);
  const notebookOptions = useMemo(() => getNotebookMoveOptions(notebooks), [notebooks]);
  const showEditor = unlocked && doc !== null;
  const metadataDisabled = readOnly || !showEditor;

  const markDirty = () => {
    editVersionRef.current += 1;
    dirtyRef.current = true;
    setDirty(true);
    touchEncryptedNoteVault();
  };
  // A newer envelope from sync (another device) replaces a clean editor.
  useEffect(() => {
    memoRef.current = memo;
    if (memo.contentMarkdown === savedMarkdownRef.current) return;
    savedMarkdownRef.current = memo.contentMarkdown;
    if (dirtyRef.current) return;
    setTitle(memo.title ?? "");
    setTagsText(memo.tags.join(", "));
    docRef.current = null;
    setDoc(null);
    setSessionNonce((value) => value + 1);
  }, [memo]);

  // Locking (manual or idle timeout) drops the plaintext from memory. The vault
  // runs the flush below first, so only edits that could not be saved are lost.
  useEffect(() => {
    if (unlocked) return;
    const lostEdits = dirtyRef.current && docRef.current !== null;
    docRef.current = null;
    setDoc(null);
    if (lostEdits) {
      dirtyRef.current = false;
      setDirty(false);
      setNotice(t("encryptedNote.unsavedLost"));
    } else if (wasEncryptedNoteVaultAutoLocked()) {
      setNotice(t("encryptedNote.autoLocked"));
    }
  }, [unlocked, t]);

  // An open vault session decrypts without asking again.
  useEffect(() => {
    if (!unlocked || doc || !envelope) return;
    let cancelled = false;
    setDecrypting(true);
    void decryptWithEncryptedNoteVault(envelope).then((next) => {
      if (cancelled || !next) return;
      docRef.current = next;
      setDoc(next);
      setEditorKey((value) => value + 1);
    }).finally(() => {
      if (!cancelled) setDecrypting(false);
    });
    return () => { cancelled = true; };
  }, [unlocked, doc, envelope]);

  useEffect(() => {
    if (readOnly || !showEditor) return;
    let cancelled = false;
    setReady(false);
    sessionRef.current = null;
    if (requiresLocalEditSession(memoRef.current)) {
      sessionRef.current = createLocalEditSession(memoRef.current);
      setReady(true);
      return;
    }
    void api.createMemoEditSession(memoRef.current.id).then(({ editSession }) => {
      if (!cancelled) { sessionRef.current = editSession; setReady(true); }
    }).catch(() => { if (!cancelled) setError(t("encryptedNote.sessionError")); });
    return () => { cancelled = true; };
  }, [memo.id, readOnly, showEditor, sessionNonce, t]);

  const submitUnlock = async (event: FormEvent) => {
    event.preventDefault();
    if (!envelope || !passphrase || unlocking) return;
    setUnlocking(true);
    setError(null);
    setNotice(null);
    try {
      const next = await unlockEncryptedNote(scope, envelope, passphrase);
      docRef.current = next;
      setDoc(next);
      setEditorKey((value) => value + 1);
      setPassphrase("");
    } catch {
      setError(t("encryptedNote.wrongPassphrase"));
    } finally {
      setUnlocking(false);
    }
  };

  const save = (): Promise<boolean> => {
    if (savingRef.current) return savingRef.current;
    const run = saveNow().finally(() => {
      savingRef.current = null;
    });
    savingRef.current = run;
    return run;
  };

  const saveNow = async () => {
    const currentDoc = docRef.current;
    if (readOnly || !dirtyRef.current || !ready || !sessionRef.current || !currentDoc || !envelope || contentError) return false;
    const currentMemo = memoRef.current;
    const version = editVersionRef.current;
    setSaving(true);
    setError(null);
    try {
      // Reusing the note's salt keeps autosave fast; each save still gets a fresh IV.
      const { contentMarkdown } = await encryptWithEncryptedNoteVault(currentDoc, envelope.kdf);
      const result = await repository.updateMemo(currentMemo, {
        expectedRevision: currentMemo.revision,
        expectedContentHash: currentMemo.contentHash,
        editSessionId: sessionRef.current.id,
        title,
        // Placeholder only; the server derives search text from it and keeps the envelope verbatim.
        contentJson: encryptedNotePlaceholderDoc(),
        contentMarkdown,
        tags: parseTagsText(tagsText),
      });
      memoRef.current = result.memo;
      savedMarkdownRef.current = result.memo.contentMarkdown;
      if (editVersionRef.current === version) {
        dirtyRef.current = false;
        setDirty(false);
      }
      await onSaved(result.memo);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("encryptedNote.saveError"));
      return false;
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;

  useEffect(() => {
    if (!dirty || !ready || readOnly || saving || !showEditor) return;
    const timer = window.setTimeout(() => void saveRef.current(), 1200);
    return () => window.clearTimeout(timer);
  }, [dirty, ready, readOnly, saving, showEditor, title, tagsText]);

  // Seals the latest edits: waits for a running save, then saves what changed during it.
  const flushEdits = async () => {
    if (savingRef.current) await savingRef.current;
    if (dirtyRef.current) await saveRef.current();
  };
  const flushRef = useRef(flushEdits);
  flushRef.current = flushEdits;

  // Every lock (idle timeout, sign-out, another passphrase) saves first while the key is cached.
  useEffect(() => registerEncryptedNoteVaultFlush(() => flushRef.current()), []);

  // Flush pending edits when switching notes.
  useEffect(() => () => {
    void flushRef.current();
  }, []);

  const lockNow = () => flushAndLockEncryptedNoteVault();
  const handleNotebookChange = (notebookId: string) => {
    const currentMemo = memoRef.current;
    if (readOnly || notebookUpdatePending || notebookId === currentMemo.notebookId) {
      setMobileNotebookSheetOpen(false);
      return;
    }
    setNotebookUpdatePending(true);
    setError(null);
    void (async () => {
      if (dirtyRef.current && !(await saveRef.current())) return;
      const sourceMemo = memoRef.current;
      await repository.moveMemos({ memoIds: [sourceMemo.id], notebookId });
      const { memo: movedMemo } = await repository.getMemo(sourceMemo.id);
      memoRef.current = movedMemo;
      savedMarkdownRef.current = movedMemo.contentMarkdown;
      await onSaved(movedMemo);
    })().catch((caught) => {
      setError(caught instanceof Error ? caught.message : t("encryptedNote.saveError"));
    }).finally(() => {
      setNotebookUpdatePending(false);
      setMobileNotebookSheetOpen(false);
    });
  };

  useLayoutEffect(() => {
    const titleSlot = headerTitleSlot;
    const status = headerStatusCluster;
    if (!titleSlot || !status) return;
    let frame = 0;
    const measure = () => {
      const titleRect = titleSlot.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      if (titleRect.width < 1 || statusRect.width < 1) return;
      const paddingRight = Number.parseFloat(getComputedStyle(titleSlot).paddingRight) || 0;
      setTitleStatusClearancePx((current) => nextTitleStatusClearance(current, titleRect.right - paddingRight, statusRect.left));
    };
    measure();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(titleSlot);
    observer.observe(status);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [dirty, headerStatusCluster, headerTitleSlot, saving, showEditor]);

  const saveStatus = saving ? "saving" : dirty ? "unsaved" : "saved";
  const saveLabel = t(`editor.saveState.${saveStatus}`);
  const saveStatusClassName = saveStatus === "saved" ? "text-slate-400" : "bg-slate-100 text-slate-700";

  return <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-card text-foreground">
    <header className="shrink-0 border-b border-slate-200 bg-card">
      <div className={cn(MEMO_EDITOR_TOP_ROW_CLASS_NAME, "border-b-0")}>
        <div ref={setHeaderTitleSlot} className="min-w-0 w-full" style={titleStatusClearancePx > 0 ? { paddingRight: titleStatusClearancePx } : undefined}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 sm:flex-nowrap">
            <MemoEditorTopRowLeading
              mobileBackButton={(
                <IconTooltip label={t("common.back")}>
                  <Button variant="ghost" size="icon" className="lg:hidden" onClick={onBackToList} aria-label={t("common.back")}><ChevronLeft className="h-4 w-4" /></Button>
                </IconTooltip>
              )}
              titleInput={(
                <MemoTitleInput className="w-full min-w-0 px-2" value={title} onValueChange={(value) => { setTitle(value); markDirty(); }} placeholder={t("encryptedNote.name")} readOnly={metadataDisabled} />
              )}
            />
            <MemoEditorMetadataRow
              rowClassName={MEMO_EDITOR_METADATA_ROW_CLASS_NAME}
              // Never hand the body to AI tag suggestions.
              contentMarkdown=""
              disabled={metadataDisabled}
              mobileNotebookPickerOpen={mobileNotebookSheetOpen}
              notebookOptions={notebookOptions}
              notebookUpdatePending={notebookUpdatePending || saving}
              repository={repository}
              selectedNotebookId={memoRef.current.notebookId}
              tagsText={tagsText}
              title={title}
              onMobileNotebookPickerOpenChange={setMobileNotebookSheetOpen}
              onNotebookChange={handleNotebookChange}
              onTagsChange={(nextTagsText) => { setTagsText(nextTagsText); markDirty(); }}
            />
          </div>
        </div>
        <div ref={setHeaderStatusCluster} className="absolute right-1 top-0 flex h-full shrink-0 items-center gap-1 sm:right-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {readOnly ? <span className="text-xs text-slate-500">{t("encryptedNote.readOnly")}</span> : showEditor ? (
              <m.span key={saveStatus} className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium", saveStatusClassName)} role="status" {...statusSettleMotion}>
                {saveStatus === "saving" ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : saveStatus === "unsaved" ? <Pencil className="h-3 w-3" aria-hidden="true" /> : <Check className="h-3 w-3" aria-hidden="true" />}
                <span className="hidden sm:inline">{saveLabel}</span>
              </m.span>
            ) : null}
          </div>
          <MemoEditorToolbarDivider className="mx-0.5 hidden h-4 sm:block" />
          <div className="flex items-center gap-0.5">
            {showEditor ? (
              <IconTooltip label={t("encryptedNote.lock")}>
                <Button type="button" variant="ghost" size="icon" onClick={() => void lockNow()} aria-label={t("encryptedNote.lock")}>
                  <Lock className="h-4 w-4" />
                </Button>
              </IconTooltip>
            ) : null}
            <MemoEditorFocusModeButton desktopFocusMode={desktopFocusMode} onToggleDesktopFocusMode={onToggleDesktopFocusMode} />
            <MemoEditorHeaderActions
              moreMenuClassName="w-48"
              onOpenExecutionCenter={onOpenExecutionCenter}
              moreMenuItems={(
                <DropdownMenuItem disabled={!showEditor} onClick={() => void lockNow()}>
                  <Lock className="h-4 w-4 text-slate-500" />
                  {t("encryptedNote.lock")}
                </DropdownMenuItem>
              )}
            />
          </div>
        </div>
      </div>
    </header>
    {error ? <p role="alert" className="border-b border-red-100 bg-red-50 px-5 py-2 text-sm text-red-700">{error}</p> : null}
    {notice && !error ? <p role="status" className="border-b border-slate-100 bg-slate-50 px-5 py-2 text-sm text-slate-600">{notice}</p> : null}
    <section className="min-h-0 flex-1 overflow-auto">
      {showEditor ? (
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {contentError ? <p role="alert" className="mb-3 text-sm text-destructive">{t("encryptedNote.saveError")}</p> : null}
          <EncryptedNoteEditor
            key={editorKey}
            doc={doc}
            editable={!readOnly && !contentError}
            onChange={(next) => { docRef.current = next; markDirty(); }}
            onContentError={() => setContentError(true)}
            onAttachmentBlocked={() => setNotice(t("encryptedNote.attachmentsBlocked"))}
          />
        </div>
      ) : (
        <div className="flex min-h-full items-center justify-center p-6">
          <form onSubmit={(event) => void submitUnlock(event)} className="grid w-full max-w-sm gap-3 rounded-xl border border-slate-200 bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <LockKeyhole className="h-4 w-4" aria-hidden="true" />
              {t("encryptedNote.lockedTitle")}
            </div>
            <p className="text-sm leading-6 text-slate-600">{t("encryptedNote.lockedDescription")}</p>
            {envelope ? (
              <>
                <label className="sr-only" htmlFor="encrypted-note-unlock">{t("encryptedNote.passphrase")}</label>
                <Input
                  id="encrypted-note-unlock"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  placeholder={t("encryptedNote.passphrase")}
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  disabled={unlocking || decrypting}
                />
                <Button type="submit" disabled={!passphrase || unlocking || decrypting}>
                  {unlocking || decrypting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                  {unlocking || decrypting ? t("encryptedNote.unlocking") : t("encryptedNote.unlock")}
                </Button>
              </>
            ) : (
              <p role="alert" className="text-sm text-destructive">{t("encryptedNote.wrongPassphrase")}</p>
            )}
            <p className="text-xs leading-5 text-slate-500">{t("encryptedNote.unsupportedFeatures")}</p>
          </form>
        </div>
      )}
    </section>
  </div>;
}
