const { SlashCommandBuilder } = require('discord.js');
const { handlers } = require('./ticket');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tickettransfer')
        .setDescription('Transfer this ticket to another support member')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('Support member to transfer this ticket to')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for transfer')
                .setRequired(false)
        ),
    category: 'ticket',
    async execute(interaction) {
        return handlers.transferTicket(interaction);
    }
};
