const { AttachmentBuilder, EmbedBuilder } = require("discord.js");
const path = require('path');
const { CaptchaGenerator } = require("captcha-canvas");
const { verifiedRoleId, administratorRoleId } = require("../Config/constants/roles.json");
const { welcomeChannelId, verificationChannelId, captchaLogChannelId } = require("../Config/constants/channel.json");
const { Version } = require("../Config/main.json");

const Color = "#32CD32"; // Default verification accent color

module.exports = {
    name: "guildMemberAdd",
    runOnce: false,
    async execute(member, client) {
        if (!member) return;

        const captchachannel = client.channels.cache.get(captchaLogChannelId);
        const verifyChannel = client.channels.cache.get(verificationChannelId);
        const welcomeChannelObj = client.channels.cache.get(welcomeChannelId);

        // Auto-verify bots
        if (member.user?.bot) {
            const roleObj = member.guild.roles.cache.get(verifiedRoleId);
            if (roleObj) {
                await member.roles.add(roleObj).catch((err) => {
                    console.error(`[Verify] Couldn't add role to bot: ${err.message}`);
                });
            }
            return;
        }

        // Human verification
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
            const systemErrorEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle('❌ Verification Error')
                .setDescription(`Verification system failed. Contact an <@&${administratorRoleId}> ASAP.`);
            
            return member.send({ embeds: [systemErrorEmbed] }).catch((err) => {
                console.error(`[Verify] Couldn't send error DM: ${err.message}`);
            });
        }

        try {
            const captchaMessage = await captchachannel.send({ 
                files: [new AttachmentBuilder(captchaBuffer, { name: "captcha.png" })] 
            });
            const captchaImage = captchaMessage.attachments.first();
            const captchaImageUrl = captchaImage?.url;
            const Server = member.guild.name;

            const baseEmbed = new EmbedBuilder()
                .setTitle('🔐 Verification Required')
                .setColor(Color)
                .setFooter({ text: `${Version}` });

            const e1 = new EmbedBuilder(baseEmbed)
                .setDescription('Type the 6-character code from the image. Case-insensitive, 10 minutes to complete.')
                .addFields(
                    { name: '📝 How It Works', value: '```1️⃣ Look at the image\n2️⃣ Type the 6-character code\n3️⃣ Case doesn\'t matter\n4️⃣ 10 min to complete```', inline: false },
                    { name: '❓ Why?', value: '> Keeps the community safe\n> Prevents bots\n> Takes 30 seconds!', inline: false },
                    { name: '🔄 Trouble?', value: '> Run `/verify` for new code\n> Copy all 6 characters\n> Check for similar letters', inline: false }
                );

            const e2 = new EmbedBuilder(baseEmbed)
                .setColor('#FF0000')
                .setDescription('❌ **Wrong Code**\n\n⚠️ Code doesn\'t match.\n\n**Try again:**\n> Check the image\n> Type all 6 characters\n> Case doesn\'t matter');

            const dmChannel = member.user.dmChannel || await member.user.createDM();
            
            // Always ping user in verification channel first
            if (verifyChannel) {
                const verifyEmbed = new EmbedBuilder()
                    .setAuthor({ name: `${Server} Security`, iconURL: member.guild.iconURL() })
                    .setTitle(`🔐 Verification Required`)
                    .setColor(Color)
                    .setDescription(`👋 **Welcome ${member}!**\n\nBefore you can access the server, verify you're human.\n\n**Quick and easy!**`)
                    .addFields(
                        { name: '📝 How to Verify', value: '```1️⃣ Run /verify below\n2️⃣ Check DMs for captcha\n3️⃣ Type the code\n4️⃣ Get access!```', inline: false },
                        { name: '⚠️ Important', value: '> 🔓 **Enable DMs**\n> ⏱️ **10 minutes** to complete\n> 🔄 Run `/verify` again if needed', inline: false },
                        { name: '❓ Need Help?', value: 'Check that:\n• DMs are open\n• You\'re typing the code exactly', inline: false }
                    )
                    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
                    .setImage('https://i.imgur.com/sEkQOCf.png')
                    .setTimestamp()
                    .setFooter({ text: '🛡️ Keeps the community safe' });
                
                verifyChannel.send({ content: `${member}`, embeds: [verifyEmbed] })
                    .then(msg => setTimeout(() => msg.delete().catch((err) => {
                        console.error(`[Verification] Failed to delete verification prompt: ${err.message}`);
                    }), 600000)); // Delete after 10 minutes
            }

            // Still try to send DM for immediate verification (legacy support)
            if (captchaImageUrl) {
                e1.setImage(captchaImageUrl);
            }

            dmChannel.send({
                embeds: [e1]
            }).catch(async () => {
                // DM failed - user already pinged in verification channel above
                console.log(`Could not DM ${member.user.tag} - they need to use /verify command`);
            });

            const filter = m => {
                if (m.author.bot) return false;
                if (m.author.id === member.id) {
                    const userInput = String(m.content).toUpperCase().trim();
                    const correctCode = String(captchaCode).toUpperCase().trim();
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
                        const roleObj = member.guild.roles.cache.get(verifiedRoleId);
                        console.log(`Role found: ${roleObj ? roleObj.name : 'NULL'}`);
                        if (roleObj) {
                            await member.roles.add(roleObj);
                            console.log(`Role added to ${member.user.tag}`);
                            
                            // Send success message with actual role name
                            const successEmbed = new EmbedBuilder()
                                .setAuthor({ name: `${Server} Verification System`, iconURL: member.guild.iconURL() })
                                .setTitle(`✅ Verification Complete!`)
                                .setColor("#00FF00")
                                .setDescription(`🎉 **Welcome to ${Server}!**\n\n━━━━━━━━━━━━━━━━━━━━━\n\n✅ You have successfully verified your account!\n\n**What happened:**\n> 🎭 Role assigned: **${roleObj.name}**\n> 🔓 Full server access granted\n> 👋 Welcome message sent\n\n**You can now:**\n• View all channels\n• Chat with members\n• Participate in events\n• Enjoy the community!`)
                                .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
                                .setFooter({ text: `${Version} • Thanks for verifying!` })
                                .setTimestamp();
                            
                            await dmChannel.send({ embeds: [successEmbed] });

                            // Log verification
                            const CaptchaLog = new EmbedBuilder()
                                .setAuthor({ name: 'Member Verification Log', iconURL: member.user.displayAvatarURL() })
                                .setTitle(`✅ New Member Verified`)
                                .setDescription(`${member} has successfully completed verification.`)
                                .addFields(
                                    { name: `👤 User`, value: `${member.user.username}\n\`${member.id}\``, inline: true },
                                    { name: `📅 Joined Server`, value: `${member.joinedAt.toDateString()}`, inline: true },
                                    { name: `🎭 Role Given`, value: `${roleObj}`, inline: true },
                                    { name: `📆 Account Created`, value: `${member.user.createdAt.toDateString()}`, inline: true },
                                    { name: `🔑 Captcha Code`, value: `\`${captchaCode}\``, inline: true },
                                    { name: `⏱️ Account Age`, value: `${Math.floor((Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24))} days`, inline: true }
                                )
                                .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
                                .setColor('#00FF00')
                                .setTimestamp();

                            if (captchachannel) captchachannel.send({ embeds: [CaptchaLog] });
                        }
                    }
                } catch (err) {
                    console.error('[Verification] Error during member verification:', err);
                }
            }).catch(async () => {
                const timeoutEmbed = new EmbedBuilder()
                    .setColor(0xFAA61A)
                    .setTitle('⏱️ Timeout')
                    .setDescription('Operation timed out. Please run `/verify` to try again.');
                
                dmChannel.send({ embeds: [timeoutEmbed] }).catch((err) => {
                    console.error(`[Verification] Failed to send timeout message: ${err.message}`);
                });
            });

        } catch (err) {
            console.error('[Verification] Error in verification process:', err);
        }
    }
};