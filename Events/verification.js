const fs = require('fs');
const { Canvas, loadImage } = require('skia-canvas');
const { AttachmentBuilder, EmbedBuilder } = require("discord.js");
const path = require('path');
const { CaptchaGenerator } = require("captcha-canvas");
const { roleID } = require("../Config/constants/roles.json");
const { welcomeChannel, verificationchannel, captchalogchannel } = require("../Config/constants/channel.json");
const { Version } = require("../Config/main.json");
const { xEmoji, Color } = require("../Config/constants/misc.json");

module.exports = {
    name: "guildMemberAdd",
    runOnce: false,
    call: async (client, args) => {
        const userCaptchaData = {};
        if (!args || !args[0]) return;
        const member = args[0];
        const captchachannel = client.channels.cache.get(captchalogchannel);
        const verifyChannel = client.channels.cache.get(verificationchannel);
        const welcomeChannelObj = client.channels.cache.get(welcomeChannel);

        if (!member || !client.users.cache.get(member.id).bot === false) return;

        // Auto-verify bots
        if (client.users.cache.get(member.id).bot) {
            const roleObj = member.guild.roles.cache.get(roleID);
            if (roleObj) {
                return member.roles.add(roleObj);
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
            return member.send(`${xEmoji} Sorry, the verification system failed. Please contact an Administrator ASAP.`).catch(() => {});
        }

        try {
            const captchaMessage = await captchachannel.send({ 
                files: [new AttachmentBuilder(captchaBuffer, { name: "captcha.png" })] 
            });
            const captchaImage = captchaMessage.attachments.first();
            const Server = member.guild.name;

            const e0 = new EmbedBuilder()
                .setTitle(`🔐 Verification Required`)
                .setColor(Color)
                .setFooter({ text: `${Version}` });

            const e1 = new EmbedBuilder(e0)
                .setDescription(`Welcome to **${Server}**!\n\n✅ **Please enter the captcha code shown below to gain access to the server.**`)
                .addFields(
                    { name: `📋 Why did you receive this?`, value: `You have received this CAPTCHA as part of our verification process to confirm that you are not an automated bot and to help protect our servers from malicious activity.\n\n**Please enter the CAPTCHA code in this conversation.**`, inline: false },
                    { name: `⚠️ Need Help?`, value: `If you are unable to read the image, please navigate to the verification channel and run the \`/verify\` command to get a new captcha.`, inline: false }
                )
                .setTimestamp();

            const e2 = new EmbedBuilder(e0).setDescription(`❌ **Incorrect captcha code.**\n\nPlease try again by entering the correct code from the image above.`);
            const e3 = new EmbedBuilder(e0).setDescription(`✅ **Verification Successful!**\n\nYou have successfully verified your identity in **${Server}** and have been assigned the <@&${roleID}> role.\n\n🎉 You now have full access to the server!`).setColor("#00FF00");

            userCaptchaData[member.id] = { captchaValue: captchaCode };

            const dmChannel = member.user.dmChannel || await member.user.createDM();
            
            // Always ping user in verification channel first
            if (verifyChannel) {
                const verifyEmbed = new EmbedBuilder()
                    .setTitle(`🔐 Verification Required`)
                    .setColor(Color)
                    .setDescription(`Welcome to **${Server}**, ${member}!\n\nTo gain access to the server, you need to verify that you're human.`)
                    .addFields(
                        { name: '📝 How to Verify', value: 'Please run the `/verify` command in this channel to receive a captcha in your DMs.', inline: false },
                        { name: '⚠️ DMs Disabled?', value: 'Make sure your DMs are enabled from server members, then run `/verify`.', inline: false }
                    )
                    .setImage('https://i.imgur.com/sEkQOCf.png')
                    .setTimestamp()
                    .setFooter({ text: 'Verification is required to access the server' });
                
                verifyChannel.send({ content: `${member}`, embeds: [verifyEmbed] })
                    .then(msg => setTimeout(() => msg.delete().catch(() => {}), 60000)); // Delete after 1 minute
            }

            // Still try to send DM for immediate verification (legacy support)
            dmChannel.send({
                embeds: [e1.setImage(captchaImage.url)]
            }).catch(async () => {
                // DM failed - user already pinged in verification channel above
                console.log(`Could not DM ${member.user.tag} - they need to use /verify command`);
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
                            
                            // Send success message with actual role name
                            const successEmbed = new EmbedBuilder()
                                .setTitle(`🔐 Verification Required`)
                                .setColor("#00FF00")
                                .setDescription(`✅ **Verification Successful!**\n\nYou have successfully verified your identity in **${Server}** and have been assigned the **${roleObj.name}** role.\n\n🎉 You now have full access to the server!`)
                                .setFooter({ text: `${Version}` })
                                .setTimestamp();
                            
                            await dmChannel.send({ embeds: [successEmbed] });

                            // Create welcome canvas
                            const canvas = new Canvas(700, 250);
                            const ctx = canvas.getContext('2d');
                            const bgPath = path.join(__dirname, '../Images/background.png');
                            console.log('Verification background path:', bgPath);
                            
                            // Load background from file
                            const background = await loadImage(bgPath);
                            ctx.drawImage(background, 0, 0, canvas.width, canvas.height);
                            ctx.strokeStyle = '#74037b';
                            ctx.strokeRect(0, 0, canvas.width, canvas.height);

                            ctx.font = '28px sans-serif';
                            ctx.fillStyle = '#ffffff';
                            ctx.fillText('Welcome to the server,', canvas.width / 2.5, canvas.height / 3.5);

                            ctx.font = '32px sans-serif';
                            ctx.fillStyle = '#ffffff';
                            ctx.fillText(`${member.displayName}!`, canvas.width / 2.5, canvas.height / 1.8);

                            // Reset clipping and draw avatar
                            ctx.save();
                            ctx.beginPath();
                            ctx.arc(125, 125, 100, 0, Math.PI * 2, true);
                            ctx.closePath();
                            ctx.clip();

                            // Get avatar URL with extension
                            const avatarURL = member.user.displayAvatarURL({ extension: 'png', size: 256 });
                            const avatar = await loadImage(avatarURL);
                            ctx.drawImage(avatar, 25, 25, 200, 200);
                            ctx.restore();

                            const attachment = new AttachmentBuilder(await canvas.toBuffer('png'), { name: 'welcome-image.png' });

                            if (welcomeChannelObj) {
                                welcomeChannelObj.send({ 
                                    content: `Welcome ${member} to the server!`, 
                                    files: [attachment] 
                                });
                            }

                            // Log verification
                            const CaptchaLog = new EmbedBuilder()
                                .setTitle(`New Member Verified`)
                                .addFields(
                                    { name: `**User:**`, value: `${member.user.username}` },
                                    { name: `**Joined Server at:**`, value: `${member.joinedAt.toDateString()}` },
                                    { name: `**Account Creation:**`, value: `${member.user.createdAt.toDateString()}` },
                                    { name: `**Captcha Code:**`, value: `${userCaptchaData[member.id].captchaValue}` },
                                    { name: `**Role Given:**`, value: `${roleObj}` }
                                )
                                .setColor(Color);

                            if (captchachannel) captchachannel.send({ embeds: [CaptchaLog] });
                        }
                    }
                } catch (err) {
                    console.log(err);
                }
            }).catch(async () => {
                dmChannel.send(`Operation timed out, please run /verify to try again.`).catch(() => {});
            });

        } catch (err) {
            console.log(err);
        }
    }
};