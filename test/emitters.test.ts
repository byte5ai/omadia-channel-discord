// Spec 2042 criterion 5: every user-visible message carries a speaker (an
// agent or `system`). The test counts the emitter paths: the Discord send
// primitives may appear in exactly one module, which takes a SemanticAnswer.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { InMemorySpeakerHistoryStore, type LogLevel } from '@omadia/channel-sdk';

import {
  deliverEphemeral,
  deliverSlashResult,
  deliverToInteraction,
  deliverToMessage,
  noticeAnswer,
  systemAnswer,
  UNATTRIBUTED_TEXT,
} from '../src/delivery.js';
import { agentAnswer, MIRA } from './helpers.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SEND_PRIMITIVES = /\.(reply|send|editReply|followUp|react|sendTyping)\(/;

function logs() {
  const entries: { level: LogLevel; message: string }[] = [];
  return {
    entries,
    ctx: {
      conversationKey: 'discord:c1',
      speakerHistory: new InMemorySpeakerHistoryStore(),
      log: (level: LogLevel, message: string) => void entries.push({ level, message }),
    },
  };
}

describe('emitter paths (criterion 5)', () => {
  it('only delivery.ts sends, replies, edits or reacts; the connection only types', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
      const lines = readFileSync(`${SRC}${file}`, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        if (SEND_PRIMITIVES.test(line)) offenders.push(`${file}:${String(i + 1)} ${line.trim()}`);
      });
    }
    const allowed = (o: string): boolean =>
      o.startsWith('delivery.ts:') || (o.startsWith('discordConnection.ts:') && o.includes('sendTyping'));
    assert.deepEqual(offenders.filter((o) => !allowed(o)), []);
  });

  it('there is no reaction and no button anywhere in the sources', () => {
    for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(`${SRC}${file}`, 'utf8');
      assert.ok(!/\.react\(|ButtonBuilder|ActionRowBuilder|ACK_EMOJI|AddReactions/.test(code), file);
    }
  });

  it('every plugin-local text is a system answer', () => {
    assert.deepEqual(systemAnswer('x').speaker, { kind: 'system' });
    const notice = { code: 'agent_disabled', text: 'Mira ist deaktiviert.', locale: 'de' } as const;
    assert.deepEqual(noticeAnswer(notice).speaker, { kind: 'system' });
    assert.equal(noticeAnswer(notice).systemNotice, notice);
  });

  it('an answer without a speaker is refused (INV-4): a system notice goes out, its text never does', async () => {
    const { entries, ctx } = logs();
    const sent: { content: string }[] = [];
    const message = { reply: async (p: { content: string }) => void sent.push(p), channel: {} };
    await deliverToMessage(message as never, { text: 'geheimer Inhalt' }, ctx);
    assert.deepEqual(sent.map((p) => p.content), [UNATTRIBUTED_TEXT]);
    assert.ok(entries.some((e) => e.level === 'error' && /without speaker/.test(e.message)));
    await deliverToMessage(message as never, agentAnswer(MIRA, 'hallo'), ctx);
    assert.equal(sent[1]?.content, 'hallo');
    assert.equal(entries.filter((e) => /without speaker/.test(e.message)).length, 1);
  });

  it('long answers are chunked: first chunk replies, the rest go to the channel', async () => {
    const { ctx } = logs();
    const replies: string[] = [];
    const sends: string[] = [];
    const message = {
      reply: async (p: { content: string }) => void replies.push(p.content),
      channel: { send: async (p: { content: string }) => void sends.push(p.content) },
    };
    await deliverToMessage(message as never, agentAnswer(MIRA, `${'zeile\n'.repeat(500)}`), ctx);
    assert.equal(replies.length, 1);
    assert.ok(sends.length >= 1);
  });

  it('ephemeral replies carry the ephemeral flag', async () => {
    const { ctx } = logs();
    const got: unknown[] = [];
    await deliverEphemeral({ reply: async (p) => void got.push(p) }, systemAnswer('nein'), ctx);
    assert.deepEqual(got, [{ content: 'nein', ephemeral: true }]);
  });
});

describe('slash-command delivery', () => {
  function interaction() {
    const calls: string[] = [];
    return {
      calls,
      target: {
        editReply: async (p: { content?: string }) => void calls.push(`edit:${p.content ?? ''}`),
        followUp: async (p: { content?: string }) => void calls.push(`follow:${p.content ?? ''}`),
        channel: { send: async (p: { content?: string }) => void calls.push(`channel:${p.content ?? ''}`) },
      },
    };
  }

  it('edits the placeholder when nothing was acknowledged', async () => {
    const { ctx } = logs();
    const i = interaction();
    await deliverSlashResult(i.target, agentAnswer(MIRA, 'fertig'), { acknowledged: false, deliverAsFollowUp: false }, ctx);
    assert.deepEqual(i.calls, ['edit:fertig']);
  });

  it('keeps the acknowledgement and adds the answer after it', async () => {
    const { ctx } = logs();
    const i = interaction();
    await deliverToInteraction(i.target, systemAnswer('Moment'), ctx);
    await deliverSlashResult(i.target, agentAnswer(MIRA, 'fertig'), { acknowledged: true, deliverAsFollowUp: false }, ctx);
    assert.deepEqual(i.calls, ['edit:Moment', 'follow:fertig']);
  });

  it('past the reply window the answer is a channel message, not an edit of a dead token', async () => {
    const { ctx } = logs();
    const i = interaction();
    await deliverSlashResult(i.target, agentAnswer(MIRA, 'spät'), { acknowledged: true, deliverAsFollowUp: true }, ctx);
    assert.deepEqual(i.calls, ['channel:spät']);
  });
});
