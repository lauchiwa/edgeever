import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ENCRYPTED_NOTE_AUTO_LOCK_MINUTE_OPTIONS, type EncryptedNoteAutoLockMinutes } from "@edgeever/shared";
import { Modal, View } from "react-native";
import { Check, ChevronDown } from "../components/icons";
import { Pressable, Text } from "../components/LocalizedText";
import {
  getMobileEncryptedNoteAutoLockMinutes,
  loadMobileEncryptedNoteAutoLockMinutes,
  saveMobileEncryptedNoteAutoLockMinutes,
} from "../lib/mobile-encrypted-note-vault";
import { useMobileLocale } from "../lib/mobile-locale";
import { styles } from "./workspace-styles";

/** Fork: settings row for the per-device vault idle timeout. */
export const MobileVaultAutoLockSetting = () => {
  const english = useMobileLocale().resolvedLocale !== "zh-CN";
  const [minutes, setMinutes] = useState(getMobileEncryptedNoteAutoLockMinutes);
  const [saveFailed, setSaveFailed] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const selectRef = useRef<ComponentRef<typeof Pressable>>(null);
  const title = english ? "Auto-lock vault" : "保险库自动锁定";
  const optionLabel = (value: number) => (english ? `${value} min` : `${value} 分钟`);

  useEffect(() => {
    let active = true;
    void loadMobileEncryptedNoteAutoLockMinutes.then((stored) => {
      if (active) setMinutes(stored);
    });
    return () => {
      active = false;
    };
  }, []);

  const openPicker = () => {
    selectRef.current?.measureInWindow((left, top, width, height) => setAnchor({ left, top: top + height + 4, width }));
  };
  const choose = (next: EncryptedNoteAutoLockMinutes) => {
    setAnchor(null);
    setMinutes(next);
    void saveMobileEncryptedNoteAutoLockMinutes(next).then((saved) => setSaveFailed(!saved));
  };

  return (
    <View style={styles.settingsContentRow}>
      <View style={styles.preferenceStack}>
        <View style={styles.preferenceText}>
          <Text style={styles.settingsRowTitle}>{title}</Text>
          <Text style={styles.settingsRowDescription}>
            {english
              ? "Lock encrypted notes and secret blocks after this long without activity. Stored on this device only."
              : "超过这段时间未操作，加密笔记和加密块会自动锁定。仅保存在本机。"}
          </Text>
          {saveFailed ? (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {english ? "Could not save this setting. It applies until the app restarts." : "无法保存这项设置，重启应用前仍然生效。"}
            </Text>
          ) : null}
        </View>
        <Pressable accessibilityLabel={title} accessibilityRole="button" onPress={openPicker} ref={selectRef} style={styles.settingsSelect}>
          <Text style={styles.settingsSelectText}>{optionLabel(minutes)}</Text>
          <ChevronDown color="#64748b" size={18} />
        </Pressable>
      </View>
      <Modal animationType="fade" onRequestClose={() => setAnchor(null)} statusBarTranslucent transparent visible={Boolean(anchor)}>
        <Pressable onPress={() => setAnchor(null)} style={styles.localePickerBackdrop}>
          {anchor ? (
            <View style={[styles.localePickerMenu, anchor]}>
              {ENCRYPTED_NOTE_AUTO_LOCK_MINUTE_OPTIONS.map((value) => {
                const active = minutes === value;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active }}
                    key={value}
                    onPress={() => choose(value)}
                    style={[styles.localePickerOption, active && styles.localePickerOptionActive]}
                  >
                    <Text style={[styles.localePickerOptionText, active && styles.localePickerOptionTextActive]}>{optionLabel(value)}</Text>
                    {active ? <Check color="#047857" size={16} /> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
};
