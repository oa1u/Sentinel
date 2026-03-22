const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');

const EMOJI_MAP = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create and manage polls')
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Create a poll with up to 10 options')
        .addStringOption(option =>
          option.setName('question')
            .setDescription('Your poll question')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('options')
            .setDescription('Poll options separated by | (e.g., Option 1 | Option 2 | Option 3)')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('duration')
            .setDescription('Poll duration in minutes (required)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(10080)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('end')
        .setDescription('End a poll early')
        .addStringOption(option =>
          option.setName('poll_id')
            .setDescription('Poll message ID')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('results')
        .setDescription('View poll results')
        .addStringOption(option =>
          option.setName('poll_id')
            .setDescription('Poll message ID')
            .setRequired(true))),
  category: 'utility',
  execute: async (interaction) => {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'create') {
      return await createPoll(interaction);
    } else if (subcommand === 'end') {
      return await endPoll(interaction);
    } else if (subcommand === 'results') {
      return await showResults(interaction);
    }
  }
};

async function createPoll(interaction) {
  const question = interaction.options.getString('question');
  const optionsStr = interaction.options.getString('options');
  const duration = interaction.options.getInteger('duration');

  const options = optionsStr.split('|').map(o => o.trim()).filter(Boolean);

  if (options.length < 2) {
    return interaction.reply({
      content: '❌ You need at least 2 options for a poll!',
      flags: require('discord.js').MessageFlags.Ephemeral
    });
  }

  if (options.length > 10) {
    return interaction.reply({
      content: '❌ Maximum 10 options allowed!',
      flags: require('discord.js').MessageFlags.Ephemeral
    });
  }

  const optionsText = options.map((opt, i) => `${EMOJI_MAP[i]} ${opt}`).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({
      name: '📊 Poll',
      iconURL: interaction.user.displayAvatarURL()
    })
    .setTitle(question)
    .setDescription(optionsText)
    .addFields(
      { name: '👤 Created by', value: `<@${interaction.user.id}>`, inline: true },
      { name: '⏱️ Status', value: duration ? `Ends <t:${Math.floor((Date.now() + duration * 60000) / 1000)}:R>` : '⚪ Ongoing', inline: true }
    )
    .setFooter({ text: 'Vote by reacting below!' })
    .setTimestamp();

  const response = await interaction.reply({
    embeds: [embed],
    withResponse: true
  });
  const msg = response?.resource?.message || await interaction.fetchReply();

  for (let i = 0; i < options.length; i++) {
    await msg.react(EMOJI_MAP[i]);
  }

  await MySQLDatabaseManager.createPoll(
    msg.id,
    interaction.guild.id,
    interaction.user.id,
    question,
    JSON.stringify(options),
    duration ? new Date(Date.now() + duration * 60000) : null
  );

  if (duration) {
    setTimeout(async () => {
      await endPollById(msg.id, interaction.channel);
    }, duration * 60000);
  }

  console.log(`[Poll] Created poll by ${interaction.user.tag}: ${question}`);
}

async function endPoll(interaction) {
  const pollId = interaction.options.getString('poll_id');

  try {
    const poll = await MySQLDatabaseManager.getPoll(pollId);

    if (!poll) {
      return interaction.reply({
        content: '❌ Poll not found!',
        flags: require('discord.js').MessageFlags.Ephemeral
      });
    }

    if (poll.user_id !== interaction.user.id && !interaction.member.permissions.has('ManageMessages')) {
      return interaction.reply({
        content: '❌ Only the poll creator or moderators can end this poll!',
        flags: require('discord.js').MessageFlags.Ephemeral
      });
    }

    if (poll.ended) {
      return interaction.reply({
        content: '❌ This poll has already ended!',
        flags: require('discord.js').MessageFlags.Ephemeral
      });
    }

    await endPollById(pollId, interaction.channel);
    await interaction.reply({
      content: '✅ Poll ended successfully!',
      flags: require('discord.js').MessageFlags.Ephemeral
    });

  } catch (error) {
    console.error('[Poll] Error ending poll:', error);
    await interaction.reply({
      content: '❌ Failed to end poll.',
      flags: require('discord.js').MessageFlags.Ephemeral
    });
  }
}

async function showResults(interaction) {
  const pollId = interaction.options.getString('poll_id');

  try {
    const message = await interaction.channel.messages.fetch(pollId).catch(() => null);
    if (!message || !message.embeds[0]) {
      return interaction.reply({
        content: '❌ Poll not found or has been deleted!',
        flags: require('discord.js').MessageFlags.Ephemeral
      });
    }

    const reactions = message.reactions.cache;
    const results = [];
    let totalVotes = 0;

    for (let i = 0; i < EMOJI_MAP.length; i++) {
      const reaction = reactions.get(EMOJI_MAP[i]);
      if (reaction) {
        const count = reaction.count - 1;
        results.push(count);
        totalVotes += count;
      }
    }

    if (totalVotes === 0) {
      return interaction.reply({
        content: '📊 No votes yet!',
        flags: require('discord.js').MessageFlags.Ephemeral
      });
    }

    const embed = message.embeds[0];
    const options = embed.description.split('\n').map(line => line.substring(2));

    const resultsText = results.map((count, i) => {
      const percentage = ((count / totalVotes) * 100).toFixed(1);
      const barLength = Math.round((count / totalVotes) * 20);
      const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength);
      return `${EMOJI_MAP[i]} **${options[i]}**\n${bar} ${count} votes (${percentage}%)`;
    }).join('\n\n');

    const resultEmbed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle(`📊 Poll Results: ${embed.title}`)
      .setDescription(resultsText)
      .addFields({ name: '📈 Total Votes', value: `${totalVotes}`, inline: true })
      .setTimestamp();

    await interaction.reply({
      embeds: [resultEmbed],
      flags: require('discord.js').MessageFlags.Ephemeral
    });

  } catch (error) {
    console.error('[Poll] Error showing results:', error);
    await interaction.reply({
      content: '❌ Failed to fetch poll results.',
      flags: require('discord.js').MessageFlags.Ephemeral
    });
  }
}

async function endPollById(pollId, channel) {
  try {
    const message = await channel.messages.fetch(pollId);
    if (!message || !message.embeds[0]) return;

    await MySQLDatabaseManager.endPoll(pollId);

    const reactions = message.reactions.cache;
    const results = [];
    let totalVotes = 0;
    let maxVotes = 0;
    let winnerIndices = [];

    for (let i = 0; i < EMOJI_MAP.length; i++) {
      const reaction = reactions.get(EMOJI_MAP[i]);
      if (reaction) {
        const count = reaction.count - 1;
        results.push(count);
        totalVotes += count;

        if (count > maxVotes) {
          maxVotes = count;
          winnerIndices = [i];
        } else if (count === maxVotes && count > 0) {
          winnerIndices.push(i);
        }
      }
    }

    const embed = message.embeds[0];
    const options = embed.description.split('\n').map(line => line.substring(2));

    let winnerText = '🏆 **Winner:** ';
    if (totalVotes === 0) {
      winnerText = '❌ No votes recorded';
    } else if (winnerIndices.length === 1) {
      winnerText += `${options[winnerIndices[0]]} (${maxVotes} votes)`;
    } else {
      winnerText = '🤝 **Tie:** ' + winnerIndices.map(i => options[i]).join(' & ');
    }

    const updatedEmbed = EmbedBuilder.from(embed)
      .setColor(0x57F287)
      .spliceFields(1, 1, { name: '⏱️ Status', value: '🔴 **Ended**', inline: true })
      .addFields({ name: '🎯 Result', value: winnerText, inline: false })
      .setFooter({ text: `Poll ended • ${totalVotes} total votes` });

    await message.edit({ embeds: [updatedEmbed] });

    console.log(`[Poll] Ended poll ${pollId} - Winner: ${winnerText}`);
  } catch (error) {
    console.error('[Poll] Error ending poll:', error);
  }
}