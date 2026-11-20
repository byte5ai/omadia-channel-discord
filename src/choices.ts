import type { SemanticAnswer } from '@omadia/channel-sdk';

/**
 * A card the agent asked as a numbered text question ("1) …", "2) …") is
 * answered by typing the number. This remembers the options of the last such
 * question per conversation and user, so that "2" replays what the second
 * option stands for (channel parity, spec 2042 §5.14: no buttons, same
 * capability). Deterministic, no model. In memory only: after a restart a
 * number is an ordinary message and the agent reads it in context.
 */

export interface ChoiceOption {
  /** What the numbered line showed. */
  readonly label: string;
  /** What the option stands for: replayed as the user's next message. */
  readonly replay: string;
}

const MAX_REMEMBERED = 500;
const NUMBER_REPLY = /^\s*(\d{1,2})\s*[.)]?\s*$/;

/** The options an answer's card asks, in the order the plain-text renderer numbers them. */
export function choiceOptionsOf(answer: SemanticAnswer): ChoiceOption[] {
  const card = answer.interactive;
  if (!card) return [];
  switch (card.kind) {
    case 'choice':
      return card.options.map((o) => ({ label: o.label, replay: o.value }));
    case 'topic':
      return card.topics.map((o) => ({ label: o.label, replay: o.value }));
    case 'slots':
      return card.slots.map((s) => ({ label: s.label, replay: s.slotId }));
    default:
      return [];
  }
}

export class PendingChoices {
  readonly #byKey = new Map<string, readonly ChoiceOption[]>();

  /** Remember (or, with no options, forget) the open question of this conversation and user. */
  remember(key: string, options: readonly ChoiceOption[]): void {
    this.#byKey.delete(key);
    if (options.length === 0) return;
    this.#byKey.set(key, options);
    if (this.#byKey.size > MAX_REMEMBERED) {
      const oldest = this.#byKey.keys().next().value;
      if (oldest !== undefined) this.#byKey.delete(oldest);
    }
  }

  /**
   * The message a typed reply stands for: the replay text of the numbered
   * option, else the text unchanged. Any reply closes the open question.
   */
  resolve(key: string, text: string): string {
    const options = this.#byKey.get(key);
    this.#byKey.delete(key);
    if (!options) return text;
    const match = NUMBER_REPLY.exec(text);
    if (!match) return text;
    return options[Number(match[1]) - 1]?.replay ?? text;
  }
}
