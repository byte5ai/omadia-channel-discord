import type { StatusTone } from './theme.js';

// A pictograph plus its optional VS16 / skin tone / ZWJ continuation.
const EMOJI_RE =
  /\p{Extended_Pictographic}(️|\p{Emoji_Modifier})?(‍\p{Extended_Pictographic}(️|\p{Emoji_Modifier})?)*/gu;

// The design system shows status as coloured text with a dot, never as emoji.
// Models love ✅/⚠️/❌ in tables, so those become a tone; every other emoji
// is dropped from the image (the CSV and alt text keep the original).
const TONE_BY_EMOJI: Record<string, StatusTone> = {
  '✅': 'success',
  '✔': 'success',
  '☑': 'success',
  '🟢': 'success',
  '🟩': 'success',
  '⚠': 'warning',
  '🟡': 'warning',
  '🟨': 'warning',
  '🟠': 'warning',
  '🟧': 'warning',
  '⏳': 'warning',
  '⌛': 'warning',
  '❗': 'warning',
  '❌': 'danger',
  '✖': 'danger',
  '⛔': 'danger',
  '🚫': 'danger',
  '🔴': 'danger',
  '🟥': 'danger',
};

export interface CellStatus {
  tone: StatusTone | null;
  text: string;
}

/** First status emoji in the cell sets the tone; all emoji are removed. */
export function parseStatus(cell: string): CellStatus {
  let tone: StatusTone | null = null;
  const text = cell
    .replace(EMOJI_RE, (e) => {
      tone ??= TONE_BY_EMOJI[e.replace(/️/g, '')] ?? null;
      return '';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { tone, text };
}
