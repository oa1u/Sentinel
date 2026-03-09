const GiveawayReaction = require('./GiveawayReaction');
const SuggestionReaction = require('./SuggestionReaction');
const TicketReaction = require('./TicketReaction');

async function invokeHandler(handler, reaction, user, client, label) {
    if (!handler) return;

    try {
        if (typeof handler.call === 'function') {
            await handler.call(client, [reaction, user]);
            return;
        }

        if (typeof handler.execute === 'function') {
            await handler.execute(reaction, user, client);
        }
    } catch (error) {
        const safeLabel = label || handler?.name || 'unknown';
        console.error(`[MessageReactionAdd] ${safeLabel} failed:`, error?.message || error);
    }
}

module.exports = {
    name: 'messageReactionAdd',
    runOnce: false,
    async execute(reaction, user, client) {
        await invokeHandler(GiveawayReaction, reaction, user, client, 'GiveawayReaction');
        await invokeHandler(SuggestionReaction, reaction, user, client, 'SuggestionReaction');
        await invokeHandler(TicketReaction, reaction, user, client, 'TicketReaction');
    }
};