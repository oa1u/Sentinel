const { resolve } = require("path");
const { readdir } = require("fs").promises;
async function * getFiles(dir) { // recursively find all event files
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
async function load(client) {
	for await (const fn of getFiles("./Events")) {
		if (fn.endsWith("_loader.js")) continue; // do not load event loader as event
		const event = require(fn);
		const handler = (...args) => event.call(client, args);
		if (event.runOnce) {
			client.once(event.name, handler);
		} else {
			client.on(event.name, handler);
		}
	}
}

module.exports = load;





