const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { addBonusXP } = require('../../Events/Leveling');
const { riddleApiUrl } = require('../../Config/constants/api.json');

const RIDDLES = [
    {
        question: 'I have keys but no locks. I have space but no rooms. You can enter but cannot go outside. What am I?',
        options: ['A map', 'A keyboard', 'A book', 'A safe'],
        answerIndex: 1
    },
    {
        question: 'The more you take, the more you leave behind. What are they?',
        options: ['Footsteps', 'Coins', 'Memories', 'Shadows'],
        answerIndex: 0
    },
    {
        question: 'What gets wetter the more it dries?',
        options: ['A sponge', 'A towel', 'Rain', 'A cloud'],
        answerIndex: 1
    },
    {
        question: 'What has hands but cannot clap?',
        options: ['A clock', 'A chair', 'A statue', 'A tree'],
        answerIndex: 0
    },
    {
        question: 'What runs but never walks?',
        options: ['A river', 'A rabbit', 'A car', 'A cheetah'],
        answerIndex: 0
    },
    {
        question: 'I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?',
        options: ['An echo', 'A whisper', 'A flute', 'A storm'],
        answerIndex: 0
    },
    {
        question: 'What can travel around the world while staying in a corner?',
        options: ['A stamp', 'A postcard', 'A shadow', 'The sun'],
        answerIndex: 0
    },
    {
        question: 'What has a neck but no head?',
        options: ['A bottle', 'A guitar', 'A river', 'A lamp'],
        answerIndex: 0
    }
];

const RIDDLE_XP_REWARD = 25;
const RESPONSE_TIME_MS = 30000;
const API_TIMEOUT_MS = 7000;
const RIDDLE_API_URL = riddleApiUrl || 'https://riddles-api.vercel.app/random';
const MAX_QUESTION_LENGTH = 220;
const MAX_ANSWER_LENGTH = 60;

const ANSWER_BANK = Array.from(
    new Set(
        RIDDLES.flatMap((riddle) => riddle.options)
            .map((answer) => String(answer).trim())
            .filter(Boolean)
    )
);

function pickRiddle() {
    return RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
}

function shuffle(array) {
    const copy = array.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function buildOptions(answer, count = 4) {
    const trimmedAnswer = String(answer || '').replace(/\s+/g, ' ').trim();
    const pool = ANSWER_BANK.filter((item) => item.toLowerCase() !== trimmedAnswer.toLowerCase());
    const picks = shuffle(pool).slice(0, Math.max(0, count - 1));
    const options = shuffle([trimmedAnswer, ...picks]);
    return {
        options,
        answerIndex: options.findIndex((opt) => opt.toLowerCase() === trimmedAnswer.toLowerCase())
    };
}

async function fetchRiddleFromApi() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
        const response = await fetch(RIDDLE_API_URL, { signal: controller.signal });
        if (!response.ok) return null;
        const data = await response.json();

        const question = String(data?.riddle || data?.question || '').replace(/\s+/g, ' ').trim();
        const answer = String(data?.answer || '').replace(/\s+/g, ' ').trim();

        if (!question || !answer) return null;
        if (question.length > MAX_QUESTION_LENGTH || answer.length > MAX_ANSWER_LENGTH) return null;

        return { question, answer };
    } catch (_) {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function getRiddle() {
    const apiRiddle = await fetchRiddleFromApi();
    if (apiRiddle) {
        const optionData = buildOptions(apiRiddle.answer, 4);
        if (optionData.options.length === 4 && optionData.answerIndex >= 0) {
            return {
                question: apiRiddle.question,
                options: optionData.options,
                answerIndex: optionData.answerIndex
            };
        }
    }

    return pickRiddle();
}

function buildButtons(prefix, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${prefix}_0`)
            .setLabel('1')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`${prefix}_1`)
            .setLabel('2')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`${prefix}_2`)
            .setLabel('3')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`${prefix}_3`)
            .setLabel('4')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
    );
}

function buildLevelingMessageContext(interaction) {
    return {
        guild: interaction.guild,
        author: interaction.user,
        member: interaction.member,
        channel: interaction.channel,
        reply: (payload) => interaction.followUp(payload)
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('riddle')
        .setDescription('Solve a riddle for a chance to earn XP'),
    category: 'fun',
    async execute(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: require('discord.js').MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const riddle = await getRiddle();
        const optionsText = riddle.options
            .map((option, index) => `${index + 1}. ${option}`)
            .join('\n');
        const customIdPrefix = `riddle_${interaction.id}`;

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Riddle Time')
            .setDescription(riddle.question)
            .addFields({ name: 'Options', value: optionsText })
            .setFooter({ text: `Choose the right answer in ${RESPONSE_TIME_MS / 1000} seconds.` })
            .setTimestamp();

        const message = await interaction.editReply({ embeds: [embed], components: [buildButtons(customIdPrefix)] });

        const collector = message.createMessageComponentCollector({
            time: RESPONSE_TIME_MS,
            max: 1,
            filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith(customIdPrefix)
        });

        collector.on('collect', async (i) => {
            const answerIndex = Number(i.customId.split('_').pop());
            const isCorrect = answerIndex === riddle.answerIndex;
            const disabledRow = buildButtons(customIdPrefix, true);

            await i.update({ components: [disabledRow] });

            if (isCorrect) {
                const resultEmbed = new EmbedBuilder()
                    .setColor(0x43B581)
                    .setTitle('Correct!')
                    .setDescription(`You earned **${RIDDLE_XP_REWARD} XP**.`)
                    .addFields({ name: 'Answer', value: riddle.options[riddle.answerIndex] });

                const levelingContext = buildLevelingMessageContext(interaction);
                await addBonusXP(levelingContext, RIDDLE_XP_REWARD).catch(() => { });

                return interaction.followUp({ embeds: [resultEmbed] });
            }

            const wrongEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle('Not quite!')
                .setDescription('Better luck next time.')
                .addFields({ name: 'Answer', value: riddle.options[riddle.answerIndex] });

            return interaction.followUp({ embeds: [wrongEmbed] });
        });

        collector.on('end', async (collected) => {
            if (collected.size > 0) return;

            const timeoutEmbed = new EmbedBuilder()
                .setColor(0xFAA61A)
                .setTitle("Time's up!")
                .setDescription(`The correct answer was **${riddle.options[riddle.answerIndex]}**.`);

            try {
                await message.edit({ components: [buildButtons(customIdPrefix, true)] });
            } catch (_) {
                // ignore
            }

            await interaction.followUp({ embeds: [timeoutEmbed] });
        });

        return null;
    }
};