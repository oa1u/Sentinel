module.exports = (guild, string) => {
	const matches = string.match(/^<@!?(\d+)>$/); // match the member's id
	if (!matches) return;
	const id = matches[1];

	return guild.members.cache.get(id);
}



