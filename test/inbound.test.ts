// The language of the sender, as far as Discord states it (S1: locale in the resolve context).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Message } from 'discord.js';

import { buildIncomingTurn, buildSlashTurn } from '../src/inbound.js';

const user = { id: 'u1', globalName: 'Uli', username: 'uli' };

describe('locale of an inbound turn', () => {
  it('a slash command carries the invoking user\'s language, else the server\'s', () => {
    const own = buildSlashTurn('ch', { channelId: 'c', guildId: 'g', locale: 'de', guildLocale: 'en-US', user }, '/agents');
    assert.equal((own.metadata as { locale?: string }).locale, 'de');
    const guild = buildSlashTurn('ch', { channelId: 'c', guildId: 'g', guildLocale: 'en-US', user }, '/agents');
    assert.equal((guild.metadata as { locale?: string }).locale, 'en-US');
    const none = buildSlashTurn('ch', { channelId: 'c', guildId: null, user }, '/agents');
    assert.equal('locale' in (none.metadata as object), false);
  });

  it('a message in a server carries the server\'s preferred locale; a DM none', () => {
    const message = (guild: { preferredLocale: string } | null): Message =>
      ({ id: 'm', channelId: 'c', guildId: guild ? 'g' : null, guild, channel: { type: guild ? 0 : 1 }, author: user }) as unknown as Message;
    assert.equal((buildIncomingTurn('ch', message({ preferredLocale: 'de' }), 'hi').metadata as { locale?: string }).locale, 'de');
    assert.equal('locale' in (buildIncomingTurn('ch', message(null), 'hi').metadata as object), false);
  });
});
