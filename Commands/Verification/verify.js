const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { CaptchaGenerator } = require("captcha-canvas");
const { sendErrorReply } = require('../../Functions/EmbedBuilders');
const { verifiedRoleId, administratorRoleId } = require("../../Config/constants/roles.json");
const { verificationChannelId, captchaLogChannelId } = require("../../Config/constants/channel.json");

const userCaptchaData = {};
// Track verification attempts per user to prevent spam
const verificationAttempts = new Map();
const VERIFICATION_TIMEOUT = 60 * 60 * 1000; // 1 hour cooldown between verifications

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify yourself by solving a CAPTCHA'),
  category: 'verification',
  async execute(interaction) {
    // Check if command is used in verification channel
    if (interaction.channelId !== verificationChannelId) {
      return sendErrorReply(
        interaction,
        'Wrong Channel',
        'This command can only be used in the verification channel.'
      );
    }

    const member = interaction.member;
    const userId = interaction.user.id;
    const captchachannel = interaction.client.channels.cache.get(captchaLogChannelId);

    // Check if member is still in guild (prevent verifying non-members)
    if (!member || !member.guild) {
      return sendErrorReply(
        interaction,
        'Error',
        'Could not verify your membership in the server.'
      );
    }

    // Check if user is already verified
    if (member.roles.cache.has(verifiedRoleId)) {
      const alreadyVerifiedEmbed = new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle('✅ Already Verified')
        .setDescription('Your account has already been verified.')
        .addFields(
          { name: 'Status', value: '**Verified** ✓\n\nYou have full access to all server channels and features.', inline: false },
          { name: 'What This Means', value: '• Access to all public channels\n• Ability to send messages\n• View member list\n• Participate in voice\n• Use bot commands', inline: false },
          { name: 'Need Help?', value: 'If you believe this is an error, contact the server admins.', inline: false }
        );
      
      return interaction.reply({ 
        embeds: [alreadyVerifiedEmbed], 
        flags: 64
      });
    }

    // Check verification attempt rate limiting
    const lastAttempt = verificationAttempts.get(userId);
    if (lastAttempt && Date.now() - lastAttempt < VERIFICATION_TIMEOUT) {
      const minutesLeft = Math.ceil((VERIFICATION_TIMEOUT - (Date.now() - lastAttempt)) / 60000);
      return sendErrorReply(
        interaction,
        'Rate Limited',
        `You must wait ${minutesLeft} more minute${minutesLeft !== 1 ? 's' : ''} before attempting verification again.`
      );
    }

    // Generate new captcha
    const captcha = new CaptchaGenerator()
      .setDimension(600, 600)
      .setCaptcha({ 
        text: Math.random().toString(36).substring(2, 8).toUpperCase(), 
        size: 70, 
        color: "#32CD32" 
      })
      .setDecoy({ opacity: 0.2 })
      .setTrace({ color: "#32CD32", size: 2 });

    const captchaBuffer = await captcha.generate();
    const captchaCode = captcha.text;
    
    console.log(`Generated captcha for ${member.user.tag}: ${captchaCode}`);

    if (!captchachannel) {
      return sendErrorReply(
        interaction,
        'System Error',
        `Verification system is not configured. Please contact an <@&${administratorRoleId}>.`
      );
    }

    try {
      // Send captcha image as an embed in log channel
      const captchaAttachment = new AttachmentBuilder(captchaBuffer, { name: "captcha.png" });
      const captchaEmbed = new EmbedBuilder()
        .setTitle("🧩 Captcha Generated")
        .setDescription(`Captcha generated for ${member.user.tag}`)
        .setImage(`attachment://captcha.png`)
        .setColor(0x5865F2)
        .setFooter({ text: `${member.guild.name} • Verification System` });
      await captchachannel.send({ embeds: [captchaEmbed], files: [captchaAttachment] });
      // Use the same attachment for DM and other logic
      const captchaImage = { url: `attachment://captcha.png` };
      const Server = member.guild.name;

      const e0 = new EmbedBuilder()
        .setTitle(`🔐 Server Verification`)
        .setColor(0x5865F2)
        .setFooter({ text: `${member.guild.name} • Verification System` });

      const e1 = new EmbedBuilder(e0)
        .setDescription(`Welcome to **${Server}**!\n\nWe use automated verification to ensure a safe community. Please complete this verification to gain access.`)
        .addFields(
          { name: '🤖 Why Verification?', value: 'This CAPTCHA test confirms you are a real person and not an automated bot or spam account.', inline: false },
          { name: '📋 How to Verify', value: '1. Look at the image below\n2. Enter the code from the image\n3. Reply with just the code (e.g., ABC123)\n4. You\'ll gain instant access!', inline: false },
          { name: '⏱️ Time Limit', value: 'You have unlimited attempts, but must verify within 1 hour.', inline: false },
          { name: '❓ Can\'t Read It?', value: 'Run `/verify` again to get a new captcha image.', inline: false }
        )
        .setTimestamp();

      const e2 = new EmbedBuilder(e0)
        .setColor(0xF04747)
        .setDescription(`❌ That code is incorrect.\n\nPlease try again. Check the image above carefully and enter the exact code shown.`);
      
      const e3 = new EmbedBuilder(e0)
        .setColor(0x43B581)
        .setDescription(`✅ Verification Successful!\n\nWelcome to **${Server}**! You have been granted access to all channels and features.`)
        .addFields(
          { name: 'You Now Have Access To:', value: '✅ All public channels\n✅ Voice channels\n✅ Bot commands\n✅ Member list\n✅ All server features', inline: false },
          { name: 'Server Rules', value: 'Please review our rules in the #rules channel to avoid infractions.', inline: false },
          { name: 'Get Started', value: 'Check the #introductions channel to introduce yourself!', inline: false }
        );

      userCaptchaData[member.id] = { captchaValue: captchaCode };

      const dmChannel = member.user.dmChannel || await member.user.createDM();
      
      await dmChannel.send({
        embeds: [e1.setImage(captchaImage.url)]
      }).catch(async () => {
        const dmErrorEmbed = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ DM Failed')
          .setDescription('Unable to send you a DM. Please enable DMs from server members and try again.');
        
        return interaction.reply({ 
          embeds: [dmErrorEmbed], 
          flags: 64
        });
      });

      const captchaSentEmbed = new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle('✅ Captcha Sent to Your DMs')
        .setDescription('Check your direct messages for the verification captcha.')
        .addFields(
          { name: 'Next Step', value: 'Open the image in your DMs and reply with the code shown.', inline: false },
          { name: 'Can\'t See DMs?', value: 'Make sure you have DMs enabled from server members. You can change this in your Discord settings.', inline: false }
        );
      
      await interaction.reply({ 
        embeds: [captchaSentEmbed], 
        flags: 64
      });

      const filter = m => {
        if (m.author.bot) return false;
        if (m.author.id === member.id) {
          const userInput = String(m.content).toUpperCase().trim();
          const correctCode = String(userCaptchaData[member.id].captchaValue).toUpperCase().trim();
          console.log(`User ${member.user.tag} entered: "${userInput}", Expected: "${correctCode}"`);
          if (userInput === correctCode) {
            return true;
          } else {
            m.channel.send({ embeds: [e2] }).catch(err => console.error('Error sending incorrect message:', err));
            return false;
          }
        }
        return false;
      };

      dmChannel.awaitMessages({
        filter,
        max: 1,
        time: 600000,
      }).then(async response => {
        try {
          if (response && response.size > 0) {
            const roleObj = member.guild.roles.cache.get(verifiedRoleId);
            console.log(`Role found: ${roleObj ? roleObj.name : 'NULL'}`);
            if (roleObj) {
              await member.roles.add(roleObj);
              console.log(`Role added to ${member.user.tag}`);
              
              // Track successful verification (prevents spam abuse)
              verificationAttempts.set(userId, Date.now());
              
              await dmChannel.send({ embeds: [e3] });

              // Log verification
              const CaptchaLog = new EmbedBuilder()
                .setTitle(`Member Verified (Manual)`)
                .addFields(
                  { name: `**User:**`, value: `${member.user.username}` },
                  { name: `**Joined Server at:**`, value: `${member.joinedAt.toDateString()}` },
                  { name: `**Account Creation:**`, value: `${member.user.createdAt.toDateString()}` },
                  { name: `**Captcha Code:**`, value: `${userCaptchaData[member.id].captchaValue}` },
                  { name: `**Role Given:**`, value: `${roleObj}` }
                )
                .setColor(0x43B581);

              if (captchachannel) captchachannel.send({ embeds: [CaptchaLog] });
            }
          }
        } catch (err) {
          console.error('[Verify] Error during verification:', err);
        }
      }).catch(async () => {
        const timeoutEmbed = new EmbedBuilder()
          .setColor(0xFAA61A)
          .setTitle('⏱️ Timeout')
          .setDescription('Operation timed out. Please run `/verify` to try again.');
        
        dmChannel.send({ embeds: [timeoutEmbed] }).catch((err) => {
          console.error(`[Verify] Failed to send timeout message: ${err.message}`);
        });
      });

    } catch (err) {
      console.error('[Verify] Error generating captcha:', err);
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Error')
        .setDescription('An error occurred while generating your captcha. Please try again.');
      
      return interaction.reply({ 
        embeds: [errorEmbed], 
        flags: 64
      });
    }
  }
};