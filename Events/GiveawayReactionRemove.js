const MySQLDatabaseManager = require('../Functions/MySQLDatabaseManager');

module.exports = {
    name: 'messageReactionRemove',
    runOnce: false,
    call: async (client, args) => {
        const [reaction, user] = args;

        if (user.bot) return;

        if (reaction.partial) {
            try {
                await reaction.fetch();
            } catch (error) {
                console.error('[Giveaway Reaction Remove] Could not fetch partial reaction:', error);
                return;
            }
        }

        const message = reaction.message;
        if (!message || !message.guild) return;
        if (reaction.emoji.name !== '🎉') return;

        try {
            const giveawayDB = MySQLDatabaseManager.getGiveawaysDB();
            const giveaway = await giveawayDB.get(message.id);
            if (!giveaway || giveaway.ended) return;

            await giveawayDB.removeEntry(message.id, user.id);
            console.log(`[Giveaway Reaction Remove] User ${user.username} (${user.id}) removed from giveaway ${giveaway.caseId || message.id}`);
        } catch (error) {
            console.error('[Giveaway Reaction Remove] Error handling giveaway entry removal:', error);
        }
    }
};