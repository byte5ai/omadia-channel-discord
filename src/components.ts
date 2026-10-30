import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';

import type { SemanticAnswer } from '@omadia/channel-sdk';

import type { PendingStore, PendingTurnContext } from './pending.js';

/** Namespace prefix so we only react to our own component interactions. */
export const CUSTOM_ID_PREFIX = 'omadia';

const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;
const MAX_SELECT_OPTIONS = 25;
// Discord component text limits.
const BUTTON_LABEL_MAX = 80;
const SELECT_LABEL_MAX = 100;
const PLACEHOLDER_MAX = 150;

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function prefixed(key: string): string {
  return `${CUSTOM_ID_PREFIX}:${key}`;
}

/** The user-facing question for the answer's interactive element, if any. */
export function interactiveQuestion(answer: SemanticAnswer): string | null {
  const i = answer.interactive;
  if (!i) return null;
  if (i.kind === 'choice' || i.kind === 'slots' || i.kind === 'topic') {
    return i.question;
  }
  return null;
}

/** Flatten an interactive element to a uniform `{ label, value }[]`, or null. */
function normalizeChoices(
  answer: SemanticAnswer,
): Array<{ label: string; value: string }> | null {
  const i = answer.interactive;
  if (!i) return null;
  switch (i.kind) {
    case 'choice':
      return i.options.map((o) => ({ label: o.label, value: o.value }));
    case 'topic':
      return i.topics.map((o) => ({ label: o.label, value: o.value }));
    case 'slots':
      // Echo the human slot label as the next message; the orchestrator's
      // booking flow keys off it. Rich slot booking is a later slice.
      return i.slots.map((s) => ({ label: s.label, value: s.label }));
    default:
      // routine_list — rendered as prose; no components in v1.
      return null;
  }
}

/**
 * Build Discord action rows for an answer's interactive element + follow-ups.
 * Choice/topic/slots become buttons (≤5) or a string-select (>5); follow-ups
 * become secondary buttons. Each component's `custom_id` is a short pending
 * key (never the prompt itself — Discord caps `custom_id` at 100 chars).
 */
export function buildComponents(
  answer: SemanticAnswer,
  pending: PendingStore,
  turnCtx: PendingTurnContext,
): Row[] {
  const rows: Row[] = [];
  const buttonSpecs: Array<{
    label: string;
    submitText: string;
    style: ButtonStyle.Primary | ButtonStyle.Secondary;
  }> = [];

  const choices = normalizeChoices(answer);
  if (choices && choices.length > 0) {
    if (choices.length <= MAX_BUTTONS_PER_ROW) {
      for (const c of choices) {
        buttonSpecs.push({
          label: c.label,
          submitText: c.value,
          style: ButtonStyle.Primary,
        });
      }
    } else {
      // Too many for buttons → one string-select row.
      const limited = choices.slice(0, MAX_SELECT_OPTIONS);
      const optionMap: Record<string, string> = {};
      const menu = new StringSelectMenuBuilder();
      limited.forEach((c, idx) => {
        const token = `o${idx}`;
        optionMap[token] = c.value;
        menu.addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel(truncate(c.label || c.value || 'Option', SELECT_LABEL_MAX))
            .setValue(token),
        );
      });
      const key = pending.put({ kind: 'select', options: optionMap, turn: turnCtx });
      menu
        .setCustomId(prefixed(key))
        .setPlaceholder(
          truncate(interactiveQuestion(answer) ?? 'Bitte wählen…', PLACEHOLDER_MAX),
        );
      rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu));
    }
  }

  for (const f of answer.followUps ?? []) {
    buttonSpecs.push({
      label: f.label,
      submitText: f.prompt,
      style: ButtonStyle.Secondary,
    });
  }

  // Lay buttons into the remaining rows (5 per row), respecting the 5-row cap.
  const remainingRows = MAX_ROWS - rows.length;
  const maxButtons = remainingRows * MAX_BUTTONS_PER_ROW;
  const limitedButtons = buttonSpecs.slice(0, maxButtons);
  for (let i = 0; i < limitedButtons.length; i += MAX_BUTTONS_PER_ROW) {
    const slice = limitedButtons.slice(i, i + MAX_BUTTONS_PER_ROW);
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
    for (const spec of slice) {
      const key = pending.put({
        kind: 'submit',
        text: spec.submitText,
        turn: turnCtx,
      });
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(prefixed(key))
          .setLabel(truncate(spec.label || spec.submitText || 'Option', BUTTON_LABEL_MAX))
          .setStyle(spec.style),
      );
    }
    rows.push(row);
  }

  return rows;
}
