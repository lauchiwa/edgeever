import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Fork overrides on top of app.json (kept identical to upstream so syncs merge
 * cleanly). The fork APK must never take upstream's updates:
 * - expo-updates would pull upstream's OTA JavaScript (same runtimeVersion,
 *   upstream EAS project), replacing this fork's encrypted-note client code.
 * - Disabling it also turns off the in-app update card, whose GitHub check
 *   points at upstream releases signed with a different key.
 * scripts/fork-invariants.test.mjs keeps these overrides in place.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  updates: { ...config.updates, enabled: false, checkAutomatically: "NEVER" },
});
