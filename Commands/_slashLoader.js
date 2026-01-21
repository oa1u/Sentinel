const { resolve } = require("path");
const { readdir } = require("fs").promises;
const { Collection } = require("discord.js");

async function * getFiles(dir) {
	const dirents = await readdir(dir, { withFileTypes: true });
	for (const dirent of dirents) {
		const res = resolve(dir, dirent.name);
		if (dirent.isDirectory()) {
			yield * getFiles(res);
		} else {
			yield res;
		}
	}
}

async function load(collection) {
	for await (const fn of getFiles("./Commands")) {
		if (fn.endsWith("_loader.js") || fn.endsWith("_slashLoader.js")) continue;
		try {
			const command = require(fn);
			if (command.data) {
				collection.set(command.data.name, command);
			}
		} catch (err) {
			// Silently skip commands that don't have slash command format
		}
	}
}

module.exports = load;






