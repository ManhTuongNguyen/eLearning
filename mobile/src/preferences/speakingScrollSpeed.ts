/**
 * Persistence for the speaking-practice karaoke scroll speed.
 *
 * A small non-secret numeric preference stored in plain AsyncStorage (the
 * same seam as the grammar auto-check flag). The control lives on the
 * Settings screen (not inside the practice flow), so the practice screen
 * only ever READS the value when it enters the karaoke view.
 *
 * Stored values are clamped into the supported range: a corrupted or
 * out-of-range entry can never wedge the teleprompter at an unreadable
 * or infinite speed — it deterministically falls back into range.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const SCROLL_SPEED_STORAGE_KEY = 'app.speakingScrollSpeedPxPerS';

/** Scroll speed bounds (pixels per second). Slow by design. */
export const SPEED_MIN_PX_PER_S = 5;
export const SPEED_MAX_PX_PER_S = 70;
export const SPEED_STEP_PX_PER_S = 5;
/** Calm default so the first session is readable out of the box. */
export const SPEED_DEFAULT_PX_PER_S = 15;

/** Clamp any stored/raw value into the supported range. */
export function clampScrollSpeed(value: number): number {
  if (!Number.isFinite(value)) {
    return SPEED_DEFAULT_PX_PER_S;
  }
  return Math.min(SPEED_MAX_PX_PER_S, Math.max(SPEED_MIN_PX_PER_S, value));
}

/** Read the persisted speed; missing or unreadable values fall back to the default. */
export async function loadSpeakingScrollSpeed(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(SCROLL_SPEED_STORAGE_KEY);
    if (raw === null) {
      return SPEED_DEFAULT_PX_PER_S;
    }
    return clampScrollSpeed(Number(raw));
  } catch {
    return SPEED_DEFAULT_PX_PER_S;
  }
}

/** Persist the speed (clamped into range). */
export async function saveSpeakingScrollSpeed(speed: number): Promise<void> {
  await AsyncStorage.setItem(
    SCROLL_SPEED_STORAGE_KEY,
    String(clampScrollSpeed(speed)),
  );
}
