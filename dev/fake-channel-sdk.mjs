// Functional DEV stub of @omadia/channel-sdk for the local test harness
// (dev/run.mjs). Provides the three runtime helpers the bundle imports, plus a
// SCRIPTED agent (dev/scenarios.mjs) so you can exercise every render path
// without a real orchestrator. NOT shipped — the build-zip INCLUDE list
// excludes dev/.

import { scriptedAnswer } from './scenarios.mjs';

export function isNoReply(answer) {
  return typeof answer?.text === 'string' && answer.text.trim() === 'NO_REPLY';
}

export function logNoReplyDrop(channel, meta = {}) {
  console.log('[no-reply] dropped', { channel, ...meta });
}

// The dev ctx publishes no channelResolver, so the plugin always lands on the
// default agent — this scripted one.
export const CHANNEL_RESOLVER_SERVICE = 'channelResolver';

export function getChatAgent() {
  return {
    async chat(input) {
      console.log(
        '[fake-sdk] chat:',
        JSON.stringify({
          userMessage: input.userMessage,
          sessionScope: input.sessionScope,
          priorTurns: input.priorTurns?.length ?? 0,
        }),
      );
      return scriptedAnswer(input.userMessage);
    },
  };
}
