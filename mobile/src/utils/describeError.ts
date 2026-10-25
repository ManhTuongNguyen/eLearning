/**
 * One line of human-readable text for any thrown value.
 *
 * Every screen's failure banner uses this. Native SQLite and streaming
 * modules sometimes reject with plain strings or objects instead of Errors,
 * so each shape is unpacked in turn: a real Error surfaces its message, a
 * plain string surfaces itself, an object with a string `message` field
 * surfaces that. Never throws, never renders "[object Object]", never leaks
 * stack traces.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  if (typeof err === 'string' && err.trim()) {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  return String(err);
}
