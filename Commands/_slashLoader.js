const { resolve, relative } = require('path');
const fs = require('fs');
const { readdir } = require('fs').promises;

// ANSI Color codes
const colors = {
	reset: '\x1b[0m',
	bright: '\x1b[1m',
	dim: '\x1b[2m',
	cyan: '\x1b[36m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	red: '\x1b[31m',
	blue: '\x1b[34m'
};

async function* getFiles(dir) {
	const dirents = (await readdir(dir, { withFileTypes: true }))
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name));

	for (const dirent of dirents) {
		const res = resolve(dir, dirent.name);
		if (dirent.isDirectory()) {
			yield* getFiles(res);
		} else {
			yield res;
		}
	}
}

async function load(collection) {
	const startTime = Date.now();
	let loadedCount = 0;
	let skippedCount = 0;
	let errorCount = 0;
	const categories = new Map();
	const errors = [];
	const warnings = [];
	const seenNames = new Map();
	const fileDurations = [];
	const verbose = String(process.env.COMMANDS_LOAD_VERBOSE || '').toLowerCase() === 'true';

	if (!collection || typeof collection.set !== 'function' || typeof collection.clear !== 'function') {
		throw new Error('Slash loader expected a Collection-like object with set/clear methods.');
	}

	collection.clear();

	console.log(`\n${colors.cyan}${colors.bright}🎮 Commands${colors.reset} (loading...)`);

	for await (const fn of getFiles("./Commands")) {
		if (fn.endsWith("_loader.js") || fn.endsWith("_slashLoader.js")) continue;
		if (!fn.endsWith('.js')) continue;

		try {
			const fileStart = Date.now();

			// Ensure file edits are picked up on subsequent loads.
			delete require.cache[require.resolve(fn)];
			const command = require(fn);
			const relFile = relative(process.cwd(), fn).replace(/\\/g, '/');

			if (command?.disabled === true) {
				skippedCount++;
				warnings.push({ file: relFile, reason: 'Command disabled via `disabled: true`' });
				continue;
			}

			// Validate command has required data
			if (!command.data) {
				throw new Error('Missing "data" property (SlashCommandBuilder)');
			}
			if (!command.execute) {
				throw new Error('Missing "execute" function');
			}
			if (typeof command.execute !== 'function') {
				throw new Error('"execute" must be a function');
			}

			const cmdName = String(command.data.name || '').trim();
			if (!cmdName) {
				throw new Error('Command name is missing');
			}
			if (!/^[a-z0-9_-]{1,32}$/.test(cmdName)) {
				throw new Error(`Invalid command name "${cmdName}"`);
			}

			if (seenNames.has(cmdName)) {
				throw new Error(`Duplicate command name "${cmdName}" (already in ${seenNames.get(cmdName)})`);
			}
			seenNames.set(cmdName, relFile);

			const category = command.category || 'uncategorized';

			collection.set(cmdName, command);

			if (!categories.has(category)) {
				categories.set(category, []);
			}
			categories.get(category).push(cmdName);

			loadedCount++;
			fileDurations.push({ file: relFile, ms: Date.now() - fileStart });
		} catch (err) {
			errorCount++;
			const relFile = relative(process.cwd(), fn).replace(/\\/g, '/');
			errors.push({ file: relFile, error: err?.message || String(err) });
			console.log(`  ${colors.red}❌${colors.reset} ${relFile}: ${colors.red}${err?.message || err}${colors.reset}`);
		}
	}

	const loadTime = Date.now() - startTime;
	const slowest = fileDurations
		.slice()
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 5);

	// Single line summary
	const categoryList = Array.from(categories.keys()).sort().join(', ');
	const errorMsg = errorCount > 0 ? ` ${colors.yellow}(${errorCount} error${errorCount !== 1 ? 's' : ''})${colors.reset}` : '';
	const skipMsg = skippedCount > 0 ? ` ${colors.yellow}(${skippedCount} skipped)${colors.reset}` : '';
	console.log(`  ${colors.green}✅${colors.reset} ${loadedCount} commands in ${categories.size} categories${errorMsg}${skipMsg} ${colors.dim}(${loadTime}ms)${colors.reset}`);

	if (categoryList) {
		console.log(`  ${colors.dim}Categories:${colors.reset} ${categoryList}`);
	}

	if (errorCount > 0) {
		console.log(`${colors.red}  Failed:${colors.reset}`);
		errors.forEach((err) => {
			console.log(`    • ${err.file}: ${colors.red}${err.error}${colors.reset}`);
		});
	}

	if (warnings.length > 0) {
		console.log(`${colors.yellow}  Warnings:${colors.reset}`);
		warnings.forEach((warn) => {
			console.log(`    • ${warn.file}: ${colors.yellow}${warn.reason}${colors.reset}`);
		});
	}

	if (verbose && slowest.length > 0) {
		console.log(`${colors.blue}  Slowest command loads:${colors.reset}`);
		slowest.forEach((item) => {
			console.log(`    • ${item.file}: ${item.ms}ms`);
		});
	}

	return {
		loaded: loadedCount,
		skipped: skippedCount,
		errors: errorCount,
		categories: categories.size,
		durationMs: loadTime,
		categoryMap: categories,
		errorList: errors,
		warningList: warnings
	};
}

function createCommandWatcher({
	collection,
	watchDir = './Commands',
	onReload = null,
	debounceMs = 500
} = {}) {
	if (!collection || typeof collection.set !== 'function' || typeof collection.clear !== 'function') {
		throw new Error('createCommandWatcher requires a Collection-like command store.');
	}

	if (typeof fs.watch !== 'function') {
		throw new Error('fs.watch is not available in this runtime.');
	}

	let timer = null;
	let reloading = false;
	let queued = false;

	const runReload = async (eventLabel) => {
		if (reloading) {
			queued = true;
			return;
		}

		reloading = true;
		queued = false;

		try {
			const result = await load(collection);
			if (typeof onReload === 'function') {
				await onReload({
					event: eventLabel,
					result
				});
			}
		} catch (error) {
			console.error(`[SlashLoader] Reload failed after ${eventLabel}: ${error?.message || error}`);
		} finally {
			reloading = false;
			if (queued) {
				queued = false;
				setTimeout(() => runReload('queued-change'), 50);
			}
		}
	};

	let watcher;
	try {
		watcher = fs.watch(watchDir, { recursive: true }, (_eventType, fileName) => {
			const safeFile = String(fileName || '').replace(/\\/g, '/');
			if (!safeFile || !safeFile.endsWith('.js')) return;
			if (safeFile.endsWith('_loader.js') || safeFile.endsWith('_slashLoader.js')) return;

			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				runReload(`file-change:${safeFile}`);
			}, Math.max(100, Number(debounceMs) || 500));
		});
	} catch (error) {
		throw new Error(`Unable to start command watcher: ${error?.message || error}`);
	}

	console.log(`${colors.blue}👀 Command watcher enabled${colors.reset} (${watchDir})`);

	return () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (watcher && typeof watcher.close === 'function') {
			watcher.close();
		}
	};
}

load.createCommandWatcher = createCommandWatcher;

module.exports = load;