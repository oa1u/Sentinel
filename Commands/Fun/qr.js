const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { AttachmentBuilder } = require('discord.js');
const QRCode = require('qrcode');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('qr')
        .setDescription('Generate a QR code from text or a link')
        .addStringOption(option =>
            option.setName('text')
                .setDescription('Text or URL to encode in the QR code')
                .setRequired(true)
        ),
    category: 'fun',
    async execute(interaction) {
        const text = interaction.options.getString('text', true).trim();

        if (!text) {
            const errorEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle('❌ Error')
                .setDescription('Please provide valid text to generate a QR code.');

            return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        await interaction.deferReply();

        try {
            const qrBuffer = await QRCode.toBuffer(text, {
                type: 'png',
                errorCorrectionLevel: 'M',
                margin: 2,
                width: 512
            });

            const qrAttachment = new AttachmentBuilder(qrBuffer, { name: 'qrcode.png' });

            const em = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📱 QR Code Generated')
                .setDescription('Here is your QR code.')
                .addFields({ name: 'Encoded Text', value: text.length > 1024 ? `${text.slice(0, 1021)}...` : text })
                .setImage('attachment://qrcode.png')
                .setFooter({ text: `Requested by ${interaction.user.username}` })
                .setTimestamp();

            await interaction.editReply({ embeds: [em], files: [qrAttachment] });
        } catch (error) {
            console.error('QR command error:', error);

            const errorEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle('❌ Error')
                .setDescription('Could not generate a QR code right now. Please try again.');

            await interaction.editReply({ embeds: [errorEmbed] });
        }
    }
};