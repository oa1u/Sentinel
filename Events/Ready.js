module.exports = {
    name: "clientReady",
    runOnce: true,
    call: async (client) => {
        console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    }
};



