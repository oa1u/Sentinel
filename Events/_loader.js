const { resolve } = require("path");
const { readdir } = require("fs").promises;

// Helper: recursively discover event files under the Events folder.
async function* getFiles(dir) {
	const dirents = await readdir(dir, { withFileTypes: true });
	for (const dirent of dirents) {
		const res = resolve(dir, dirent.name);
		if (dirent.isDirectory()) {
			yield* getFiles(res);
		} else {
			yield res;
		}
	}
}

let loadedEventCount = 0;

// Load all event files and register them on the Discord client.
async function load(client) {
	let eventCount = 0;
	let errorCount = 0;
	const eventNames = [];

	console.log('\n📡 Events (loading...)');

	for await (const fn of getFiles("./Events")) {
		if (fn.endsWith("_loader.js")) continue; // Don't load the loader itself as an event.

		try {
			const event = require(fn);

			// Skip files that don't have event properties.
			if (!event.name || (!event.call && !event.execute)) {
				continue;
			}

			// Support both 'call' and 'execute' patterns for event handlers.
			let handler;
			if (event.call) {
				// 'call' pattern: call(client, args) where args is an array.
				handler = (...args) => event.call(client, args);
			} else if (event.execute) {
				// Standard Discord.js pattern: execute(...args, client).
				handler = (...args) => event.execute(...args, client);
			}

			if (typeof handler !== 'function') {
				throw new Error('Invalid event handler');
			}

			if (event.runOnce) {
				client.once(event.name, handler);
			} else {
				client.on(event.name, handler);
			}

			eventCount++;
			eventNames.push(`${event.name}${event.runOnce ? ' (once)' : ''}`);
		} catch (err) {
			errorCount++;
			console.error(`  ❌ Error: ${err.message}`);
		}
	}

	loadedEventCount = eventCount;
	const errorMsg = errorCount > 0 ? ` (${errorCount} error${errorCount !== 1 ? 's' : ''})` : '';
	console.log(`  ✅ ${eventCount} loaded${errorMsg}\n`);
}

module.exports = load;
module.exports.getEventCount = () => loadedEventCount;