// Spec 2042 criteria 29/30 (plain text, name line only where INV-4 asks) and
// 31 (no undeclared decoration reaches the user).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  admitDecorations,
  decorationsFor,
  InMemorySpeakerHistoryStore,
  type SemanticAnswer,
} from '@omadia/channel-sdk';

import { buildPayloads } from '../src/delivery.js';
import { DISCORD_CHANNEL_TYPE, renderAnswer } from '../src/renderer.js';
import { agentAnswer, MIRA, PAUL } from './helpers.js';

function ctx() {
  return { conversationKey: 'discord:c1', speakerHistory: new InMemorySpeakerHistoryStore() };
}

describe('plain-text rendering (criteria 29/30)', () => {
  it('one agent in the conversation: no name line, ever', () => {
    const c = ctx();
    assert.equal(renderAnswer(agentAnswer(MIRA, 'Hallo.'), c).content, 'Hallo.');
    assert.equal(renderAnswer(agentAnswer(MIRA, 'Noch eins.'), c).content, 'Noch eins.');
  });

  it('two agents: a name line where the speaker would be unclear', () => {
    const c = ctx();
    renderAnswer(agentAnswer(MIRA, 'Hallo.'), c);
    assert.equal(renderAnswer(agentAnswer(PAUL, 'Hi.'), c).content, 'Paul: Hi.');
  });

  it('a consultation shows the colleague as plain attribution', () => {
    const answer = agentAnswer(MIRA, 'Das sagt Paul dazu.', {
      contributions: [{ id: 'c1', speaker: PAUL, text: 'Frist ist Freitag.', status: 'delivered' }],
    });
    const { content } = renderAnswer(answer, ctx());
    assert.match(content, /Das sagt Paul dazu\.\n\nPaul: Frist ist Freitag\./);
  });

  it('a system notice is its own text, never under an agent name', () => {
    const answer: SemanticAnswer = {
      text: 'ignored',
      speaker: { kind: 'system' },
      systemNotice: { code: 'agent_disabled', text: 'Mira ist deaktiviert.', locale: 'de' },
    };
    assert.equal(renderAnswer(answer, ctx()).content, 'Mira ist deaktiviert.');
  });

  it('a card degrades to numbered text', () => {
    const answer = agentAnswer(MIRA, 'Welche?', {
      interactive: { kind: 'choice', question: 'Welche Variante?', options: [{ label: 'A', value: 'va' }, { label: 'B', value: 'vb' }] },
    } as Partial<SemanticAnswer>);
    assert.match(renderAnswer(answer, ctx()).content, /Welche Variante\?\n1\) A\n2\) B/);
  });

  it('turns GFM tables into an aligned code block and masked links into plain links', () => {
    const { content } = renderAnswer(agentAnswer(MIRA, '[Doku](https://x.test)\n\n| a | b |\n|---|---|\n| 1 | 2 |'), ctx());
    assert.match(content, /Doku \(https:\/\/x\.test\)/);
    assert.match(content, /```\na \| b\n/);
  });
});

describe('no undeclared decoration (criterion 31)', () => {
  const everything = agentAnswer(MIRA, 'Antwort.', {
    verifier: { status: 'verified', claims: 3 },
    followUps: [{ label: 'Weiter', prompt: 'weiter' }],
    disclaimer: 'Haftungsausschluss',
    agentsConsulted: [{ agentId: 'paul', toolName: 'query_paul', durationMs: 1 }],
    privacyReceipt: { datasetsInterned: 2, fieldsMasked: 3, verbsExecuted: [], pseudonymProjectionUsed: true },
    interactive: { kind: 'choice', question: 'Welche?', options: [{ label: 'A', value: 'a' }] },
  } as unknown as Partial<SemanticAnswer>);

  it('renders no badge, footer, follow-up list, disclaimer, receipt or button', () => {
    const result = renderAnswer(everything, ctx());
    for (const needle of ['Haftungsausschluss', 'Weiter', 'Privacy', 'Konsultiert', 'Du kannst auch fragen', 'verifiziert', '🛡', '💡']) {
      assert.ok(!result.content.includes(needle), `leaked: ${needle}`);
    }
    assert.deepEqual(result.embeds, []);
    assert.ok(buildPayloads(result).every((p) => !('components' in p)));
  });

  it('declares no decoration of its own and the registry lets Discord render only the disclosure line', () => {
    const result = renderAnswer(everything, ctx());
    assert.deepEqual(admitDecorations(DISCORD_CHANNEL_TYPE, result.decorations).refused, []);
    assert.deepEqual(decorationsFor(DISCORD_CHANNEL_TYPE).map((d) => d.id), ['ai_disclosure_line']);
  });

  it('the AI disclosure line the kernel folded into the text is delivered as is', () => {
    const { content } = renderAnswer(agentAnswer(MIRA, 'Hallo.\n\nKI-generiert.'), ctx());
    assert.equal(content, 'Hallo.\n\nKI-generiert.');
  });

  it('image attachments stay content; files become a plain link', () => {
    const answer = agentAnswer(MIRA, 'Hier.', {
      attachments: [
        { kind: 'image', url: 'https://i.test/a.png', altText: 'Diagramm' },
        { kind: 'file', url: 'https://f.test/a.xlsx', altText: 'Tabelle' },
      ],
    } as Partial<SemanticAnswer>);
    const result = renderAnswer(answer, ctx());
    assert.equal(result.embeds.length, 1);
    assert.match(result.content, /Tabelle: https:\/\/f\.test\/a\.xlsx/);
  });
});
