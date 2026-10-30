// Tokens from the omadia UI design system (canvas "omadia UI", boards
// "Tokens: Nacht und Tag" and "Daten"). No accent colour: emphasis is light,
// colour is status only — so a table image has exactly three status hues.

export type StatusTone = 'success' | 'warning' | 'danger';

export interface TableTheme {
  /**
   * Grund — the room around the panel. `transparent` lets the host's own
   * background show through (chat themes, hover states).
   */
  ground: string;
  /** Fläche — the table panel. */
  surface: string;
  /** Linie — panel border and header rule. */
  line: string;
  /** Tinte — cell text. */
  ink: string;
  /** Meta — header labels, page footer. */
  meta: string;
  status: Record<StatusTone, string>;
  /** Day only: light comes from top right, so the shadow falls bottom left. */
  shadow?: string;
}

export const OMADIA_NIGHT: TableTheme = {
  ground: '#0A0A0B',
  surface: '#111113',
  line: '#222226',
  ink: '#F3EFE6',
  meta: '#85858D',
  status: { success: '#3FC1EE', warning: '#FFB547', danger: '#FF6A55' },
};

export const OMADIA_DAY: TableTheme = {
  ground: '#E2E2DE',
  surface: '#ECECE8',
  line: '#D2D2CC',
  ink: '#141416',
  meta: '#5C5C63',
  status: { success: '#0A6F92', warning: '#8F5408', danger: '#B3311C' },
  shadow: '-3px 4px 14px rgba(20,20,22,.08)',
};
