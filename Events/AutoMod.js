const { MessageFlags, EmbedBuilder } = require('discord.js');
const { administratorRoleId, moderatorRoleId } = require('../Config/constants/roles.json');
const { serverLogChannelId } = require('../Config/constants/channel.json');
const misc = require('../Config/constants/misc.json');
const blockedWordsList = require('../Config/constants/blockedWords.json');

// Fallbacks in case config is messed up
const blockedWords = Array.isArray(blockedWordsList) ? blockedWordsList : [];
const blockInvites = misc.blockExternalInvites !== undefined ? misc.blockExternalInvites : true;
const mentionThreshold = misc.maxMentionsBeforeFlag || 6;

const inviteRegex = /(https?:\/\/)?(www\.)?(discord\.gg|discord\.com\/invite)\/([A-Za-z0-9-]+)/gi;

module.exports = {
	name: 'messageCreate',
	runOnce: false,
	call: async (client, args) => {
		const [message] = args;
		if (!message || message.author.bot) return;
		if (!message.guild) return; // ignore DMs

		const member = message.member;
		const isStaff = member?.roles.cache.has(administratorRoleId) || member?.roles.cache.has(moderatorRoleId);
		if (isStaff) return; // let staff post whatever

		const lower = message.content.toLowerCase();
		let reason = null;

		// Check for Discord invite links (allow this server's invites)
		if (blockInvites && /(discord\.gg|discord\.com\/invite)\//i.test(message.content)) {
			const codes = Array.from(message.content.matchAll(inviteRegex)).map(m => m[4]).filter(Boolean);
			if (codes.length) {
				for (const code of codes) {
					try {
						const invite = await message.client.fetchInvite(code);
						const inviteGuildId = invite?.guild?.id;
						if (inviteGuildId && inviteGuildId !== message.guild.id) {
							reason = `External invite detected (code: ${code})`;
							break;
						}
						// If no guild info, treat as external for safety
						if (!inviteGuildId) {
							reason = `External invite detected (code: ${code})`;
							break;
						}
					} catch (err) {
						// If fetch fails, assume external to stay safe
						reason = `External invite detected (code: ${code})`;
						break;
					}
				}
			}
		}

		// Check for mass mentions
		const mentionCount = (message.mentions.users.size || 0) + (message.mentions.roles.size || 0);
		if (!reason && mentionThreshold > 0 && mentionCount >= mentionThreshold) {
			reason = `Mass mention (${mentionCount})`;
		}

		// Check banned words
		if (!reason && blockedWords.length) {
			const matched = blockedWords.find(w => w && lower.includes(String(w).toLowerCase()));
			if (matched) {
				reason = `Blocked word detected ("${matched}")`;
			}
		}

		if (!reason) return;

		await message.delete().catch((err) => {
			console.error(`[AutoMod] Couldn't delete message: ${err.message}`);
		});

		// Log it
		const logEmbed = new EmbedBuilder()
			.setColor(0xFF4444)
			.setAuthor({ name: '🛡️ AutoMod Detection', iconURL: client.user.displayAvatarURL() })
			.setTitle('Message Filtered')
			.setDescription(`A message was automatically removed for violating server rules.`)
			.addFields(
				{ name: '👤 User', value: `${message.author} (${message.author.tag})\n\`${message.author.id}\``, inline: true },
				{ name: '📍 Channel', value: `${message.channel}\n\`#${message.channel.name}\``, inline: true },
				{ name: '⚠️ Reason', value: `\`\`\`${reason}\`\`\``, inline: false },
				{ name: '📝 Message Content', value: message.content ? `\`\`\`${message.content.slice(0, 1000)}\`\`\`` : '`(no text content)`', inline: false }
			)
			.setFooter({ text: `User ID: ${message.author.id}` })
			.setTimestamp();

		// DM the user
		const userEmbed = new EmbedBuilder()
			.setColor(0xFF6B6B)
			.setAuthor({ name: '⚠️ Message Removed', iconURL: message.guild.iconURL() })
			.setDescription(`Your message was automatically removed by AutoMod.`)
			.addFields(
				{ name: '📌 Reason', value: `\`${reason}\``, inline: false },
				{ name: '💡 Tip', value: 'Please review the server rules to avoid future violations.', inline: false }
			)
			.setFooter({ text: message.guild.name })
			.setTimestamp();

		// Try DMing them first
		try {
			await message.author.send({ embeds: [userEmbed] });
		} catch (err) {
			// DMs off, send in channel and delete after 8s
			message.channel.send({ embeds: [userEmbed], flags: MessageFlags.SuppressNotifications })
				.then(msg => {
					setTimeout(() => msg.delete().catch(() => {}), 8000);
				})
				.catch((err) => {
					console.error(`[AutoMod] Couldn't notify: ${err.message}`);
				});
		}

		// Log it
		const logChannel = message.client.channels.cache.get(serverLogChannelId);
		if (logChannel) {
			logChannel.send({ embeds: [logEmbed] }).catch((err) => {
				console.error(`[AutoMod] Couldn't log: ${err.message}`);
			});
		}
	}
};