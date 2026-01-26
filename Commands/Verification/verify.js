const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { CaptchaGenerator } = require("captcha-canvas");
const { roleID } = require("../../Config/constants/roles.json");
const { verificationchannel, captchalogchannel } = require("../../Config/constants/channel.json");
const { Color } = require("../../Config/constants/misc.json");

const colorInt = parseInt(Color.replace('#', ''), 16);
const userCaptchaData = {};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Request a new verification captcha'),
  category: 'management',
  async execute(interaction) {
    // Check if command is used in verification channel
    if (interaction.channelId !== verificationchannel) {
      return interaction.reply({ 
        content: '❌ This command can only be used in the verification channel.', 
        ephemeral: true 
      });
    }

    const member = interaction.member;
    const captchachannel = interaction.client.channels.cache.get(captchalogchannel);

    // Check if user is already verified
    if (member.roles.cache.has(roleID)) {
      return interaction.reply({ 
        content: '✅ You are already verified!', 
        ephemeral: true 
      });
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
      return interaction.reply({ 
        content: '❌ Verification system is not configured. Please contact an administrator.', 
        ephemeral: true 
      });
    }

    try {
      const captchaMessage = await captchachannel.send({ 
        files: [new AttachmentBuilder(captchaBuffer, { name: "captcha.png" })] 
      });
      const captchaImage = captchaMessage.attachments.first();
      const Server = member.guild.name;

      const e0 = new EmbedBuilder()
        .setTitle(`🔐 Verification Required`)
        .setColor(colorInt)
        .setFooter({ text: `Verification System` });

      const e1 = new EmbedBuilder(e0)
        .setDescription(`Welcome to **${Server}**!\n\n✅ **Please enter the captcha code shown below to gain access to the server.**`)
        .addFields(
          { name: `📋 Instructions`, value: `You have received this CAPTCHA as part of our verification process to confirm that you are not an automated bot.\n\n**Please enter the CAPTCHA code in this conversation.**`, inline: false },
          { name: `⚠️ Need Help?`, value: `If you are unable to read the image, please run the \`/verify\` command again to get a new captcha.`, inline: false }
        )
        .setTimestamp();

      const e2 = new EmbedBuilder(e0).setDescription(`❌ **Incorrect captcha code.**\n\nPlease try again by entering the correct code from the image above.`);
      const e3 = new EmbedBuilder(e0).setDescription(`✅ **Verification Successful!**\n\nYou have successfully verified your identity in **${Server}** and have been assigned the verified role.\n\n🎉 You now have full access to the server!`).setColor("#00FF00");

      userCaptchaData[member.id] = { captchaValue: captchaCode };

      const dmChannel = member.user.dmChannel || await member.user.createDM();
      
      await dmChannel.send({
        embeds: [e1.setImage(captchaImage.url)]
      }).catch(async () => {
        return interaction.reply({ 
          content: '❌ Unable to send you a DM. Please enable DMs from server members and try again.', 
          ephemeral: true 
        });
      });

      await interaction.reply({ 
        content: '✅ A new captcha has been sent to your DMs! Please check your messages.', 
        ephemeral: true 
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
          console.log(`Response received for ${member.user.tag}, size: ${response.size}`);
          if (response && response.size > 0) {
            const roleObj = member.guild.roles.cache.get(roleID);
            console.log(`Role found: ${roleObj ? roleObj.name : 'NULL'}`);
            if (roleObj) {
              await member.roles.add(roleObj);
              console.log(`Role added to ${member.user.tag}`);
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
                .setColor(colorInt);

              if (captchachannel) captchachannel.send({ embeds: [CaptchaLog] });
            }
          }
        } catch (err) {
          console.log(err);
        }
      }).catch(async () => {
        dmChannel.send(`⏱️ Operation timed out, please run /verify to try again.`).catch(() => {});
      });

    } catch (err) {
      console.log(err);
      return interaction.reply({ 
        content: '❌ An error occurred while generating your captcha. Please try again.', 
        ephemeral: true 
      });
    }
  }
};