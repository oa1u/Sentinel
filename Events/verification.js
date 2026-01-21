const fs = require('fs');
const Canvas = require('canvas');
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
            .setDimension(400, 150)
            .setBackground();

        const captchaBuffer = await captcha.generate();
        const captchaCode = captcha.text;

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
                .setTitle(`Verification`)
                .setFooter({ text: `${Version}` });

            const e1 = new EmbedBuilder(e0)
                .setDescription(`Welcome To **${Server}**!\nPlease make sure you enter the captcha code below successfully to get access to **${Server}**!`)
                .addFields(
                    { name: `**Why did you receive this?**`, value: `You have received this CAPTCHA as part of our verification process to confirm that you are not an automated bot and to help protect our servers from malicious activity.\nPlease ensure that you enter the CAPTCHA code in this conversation.` },
                    { name: `**Error**`, value: `If you are unable to read the image, please navigate to the verification channel designated by the server administrators and run the /verify command` }
                );

            const e2 = new EmbedBuilder(e0).setDescription(`You've entered the captcha incorrectly.`);
            const e3 = new EmbedBuilder(e0).setDescription(`You have successfully verified your identity in ${Server} and have been assigned the <@${roleID}> role.\nYou now have full access to the server.`);

            userCaptchaData[member.id] = { captchaValue: captchaCode };

            const dmChannel = member.user.dmChannel || await member.user.createDM();
            
            dmChannel.send({
                embeds: [e1.setImage(captchaImage.url)]
            }).catch(async () => {
                if (verifyChannel) {
                    const enableDMEmb = new EmbedBuilder()
                        .setTitle(`Enable DM's`)
                        .setDescription(`Please enable DMs then run the command /verify`)
                        .setImage('https://i.imgur.com/sEkQOCf.png');
                    verifyChannel.send({ content: `<@!${member.user.id}>`, embeds: [enableDMEmb] })
                        .then(msg => setTimeout(() => msg.delete().catch(() => {}), 20000));
                }
            });

            const filter = m => {
                if (m.author.bot) return;
                if (m.author.id === member.id && String(m.content).toUpperCase() === String(userCaptchaData[member.id].captchaValue).toUpperCase()) {
                    return true;
                } else {
                    m.channel.send({ embeds: [e2] });
                    return false;
                }
            };

            dmChannel.awaitMessages({
                filter,
                max: 1,
                time: 600000,
            }).then(async response => {
                try {
                    if (response && response.size > 0) {
                        const roleObj = member.guild.roles.cache.get(roleID);
                        if (roleObj) {
                            await dmChannel.send({ embeds: [e3] });
                            await member.roles.add(roleObj);

                            // Create welcome canvas
                            const canvas = Canvas.createCanvas(700, 250);
                            const ctx = canvas.getContext('2d');
                            const bgPath = path.join(__dirname, '../Images/background.png');
                            console.log('Verification background path:', bgPath);
                            const background = await Canvas.loadImage(bgPath);
                            ctx.drawImage(background, 0, 0, canvas.width, canvas.height);
                            ctx.strokeStyle = '#74037b';
                            ctx.strokeRect(0, 0, canvas.width, canvas.height);

                            ctx.font = '28px sans-serif';
                            ctx.fillStyle = '#ffffff';
                            ctx.fillText('Welcome to the server,', canvas.width / 2.5, canvas.height / 3.5);

                            ctx.font = '32px sans-serif';
                            ctx.fillStyle = '#ffffff';
                            ctx.fillText(`${member.displayName}!`, canvas.width / 2.5, canvas.height / 1.8);

                            ctx.beginPath();
                            ctx.arc(125, 125, 100, 0, Math.PI * 2, true);
                            ctx.closePath();
                            ctx.clip();

                            const avatar = await Canvas.loadImage(member.user.displayAvatarURL({ forceStatic: false }));
                            ctx.drawImage(avatar, 25, 25, 200, 200);

                            const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'welcome-image.png' });

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
                                    { name: `**User:**`, value: `${member.user.tag}` },
                                    { name: `**Joined Server at:**`, value: `${member.joinedAt.toDateString()}` },
                                    { name: `**Account Creation:**`, value: `${member.user.createdAt.toDateString()}` },
                                    { name: `**Captcha Code:**`, value: `${userCaptchaData[member.id].captchaValue}` },
                                    { name: `**Role Given:**`, value: `${roleObj}` }
                                )
                                .setColor(parseInt(Color.replace('#', ''), 16));

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



