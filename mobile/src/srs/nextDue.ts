/**
 * The shared "when is the next card due" line for the caught-up state of a
 * practice session (WORD_BANK_V1 / SENTENCE_LIVE_V1). Callers filter their own
 * records (words also exclude dataless cards) and pass the due timestamps;
 * this module owns the relative ("42 min") + absolute ("Oct 25 at 4:05 PM")
 * formatting, which both practice screens used to duplicate verbatim.
 */

/**
 * Format the soonest of the given due timestamps relative to `now`; null when
 * nothing is ever due. Already-due cards report "Next due now."
 */
export function formatNextDueLabel(dueTimestamps: readonly number[], now: Date): string | null {
  const pending = dueTimestamps.filter(dueMs => Number.isFinite(dueMs));
  if (pending.length === 0) {
    return null;
  }

  const nextMs = Math.min(...pending);
  const deltaMs = nextMs - now.getTime();
  if (deltaMs <= 0) {
    return 'Next due now.';
  }

  const minutes = Math.ceil(deltaMs / 60_000);
  let relative: string;
  if (minutes < 60) {
    relative = `${minutes} min`;
  } else {
    const hours = Math.ceil(minutes / 60);
    if (hours < 24) {
      relative = `${hours} h`;
    } else {
      const days = Math.ceil(hours / 24);
      relative = `${days} day${days === 1 ? '' : 's'}`;
    }
  }

  const next = new Date(nextMs);
  const absolute = `${next.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })} at ${next.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
  return `Next due in ${relative} (${absolute}).`;
}
