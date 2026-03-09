const MySQLDatabaseManager = require('../Functions/MySQLDatabaseManager');

// Tracks reactions on giveaway messages and records entries in the giveaway database.
// React with 🎉 to enter — this adds the user to the persistent entries table.
module.exports = {
    name: 'messageReactionAdd',
    disabled: true,
    runOnce: false,
    call: async (client, args) => {
        const [reaction, user] = args;

        // Ignore bot reactions—they can't win giveaways!
        if (user.bot) return;

        // If the reaction is partial, fetch the full data so we can work with it.
        if (reaction.partial) {
            try {
                await reaction.fetch();
            } catch (error) {
                console.error('[Giveaway Reaction] Could not fetch partial reaction:', error);
                return;
            }
        }

        const message = reaction.message;
        if (!message || !message.guild) return;

        // Only handle 🎉 reactions, since that's how users enter giveaways.
        if (reaction.emoji.name !== '🎉') return;

        try {
            // Let's check if this message is actually a giveaway.
            const giveawayDB = MySQLDatabaseManager.getGiveawaysDB();
            const giveaway = await giveawayDB.get(message.id);

            if (!giveaway) return; // Not a giveaway message

            // If the giveaway has ended, let the user know they can't enter anymore.
            if (giveaway.ended) {
                console.log(`[Giveaway Reaction] User ${user.username} tried to enter ended giveaway ${giveaway.caseId}`);
                return;
            }

            // Add user to giveaway entries
            await giveawayDB.addEntry(message.id, user.id);
            console.log(`[Giveaway Reaction] User ${user.username} (${user.id}) entered giveaway ${giveaway.caseId || message.id}`);

        } catch (error) {
            console.error('[Giveaway Reaction] Error handling giveaway entry:', error);
        }
    }
};