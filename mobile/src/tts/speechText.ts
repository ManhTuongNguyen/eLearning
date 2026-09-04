/**
 * Speech-text sanitizer for read-aloud playback (SPEC TASK-078 follow-up).
 *
 * Chat messages carry screen-oriented markup that becomes noise once
 * spoken: inline markdown delimiters (`**bold**`, `_italic_`, `~~strike~~`,
 * `` `code` ``), structural line prefixes (headings `#`, blockquotes `>`,
 * bullets `-`/`*`), and emoji or other pictographic icons. toSpeechText()
 * reduces raw message content to the plain words a TTS engine should read:
 * markdown delimiters collapse into the surrounding whitespace (the words
 * they wrapped stay), icons and emoji joiner code points are removed, and
 * leftover whitespace is normalized.
 *
 * Pure string shaping — no engine, preference or playback state — so every
 * speech surface (chat rows, sample-conversation lines) shares one
 * definition of "what gets spoken".
 */

/**
 * Emoji sequence glue: zero-width joiner, variation selectors and the
 * combining keycap mark. Removed outright so composite emoji disappear
 * with their base glyphs instead of leaving stray spaces mid-word.
 */
const EMOJI_JOINERS = /[\u{200D}\u{FE0E}\u{FE0F}\u{20E3}]/gu;

/**
 * Pictographs and symbols that a TTS engine would read as garbage: the
 * astral emoji planes (U+1F000–U+1FAFF, including emoticons, transport,
 * flags and skin-tone modifiers), arrows, technical and geometric symbols,
 * box drawing, dingbats, enclosed alphanumerics, and the stray ©/®/™/ℹ/•
 * glyphs. Replaced by one space so surrounding words stay separated.
 */
const ICONS =
  /[\u{00A9}\u{00AE}\u{2022}\u{2023}\u{2122}\u{2139}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{2500}-\u{27BF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}\u{3030}\u{303D}\u{3297}\u{3299}\u{1F000}-\u{1FAFF}]/gu;

/** Inline markdown delimiter runs (`***`, `**`, `__`, `~~`, backticks). */
const MARKDOWN_MARKS = /[*_~`]+/g;

/** Structural line prefixes: markdown headings, blockquotes, bullets. */
const LINE_MARKUP = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/gm;

/** Marker/icon removal leaves gaps before sentence punctuation. */
const SPACE_BEFORE_PUNCTUATION = /\s+([,.!?;:])/g;

const WHITESPACE_RUNS = /\s+/g;

/**
 * Converts raw chat content into the plain, speakable form. Returns an
 * empty string when nothing meaningful remains (decoration-only content).
 */
export function toSpeechText(raw: string): string {
  return raw
    .replace(EMOJI_JOINERS, '')
    .replace(ICONS, ' ')
    .replace(MARKDOWN_MARKS, ' ')
    .replace(LINE_MARKUP, '')
    .replace(SPACE_BEFORE_PUNCTUATION, '$1')
    .replace(WHITESPACE_RUNS, ' ')
    .trim();
}
