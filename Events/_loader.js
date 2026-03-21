const { resolve, relative } = require('path');
const { readdir } = require('fs').promises;

// ANSI color helpers for readable startup logs.
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

let loadedEventCount = 0;

// Track listeners registered by this loader so we can safely reload.
const clientListenerRegistry = new WeakMap();

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

function unregisterPreviousListeners(client) {
	const previous = clientListenerRegistry.get(client) || [];
	previous.forEach((entry) => {
		try {
			client.off(entry.name, entry.handler);
		} catch (_) {
			// Ignore stale listener cleanup errors.
		}
	});
	clientListenerRegistry.set(client, []);
}

function registerTrackedListener(client, name, runOnce, handler, source) {
	if (runOnce) {
		client.once(name, handler);
	} else {
		client.on(name, handler);
	}

	const current = clientListenerRegistry.get(client) || [];
	current.push({ name, handler, runOnce, source });
	clientListenerRegistry.set(client, current);
}

function getHandler(eventModule, client) {
	const hasCall = typeof eventModule?.call === 'function';
	const hasExecute = typeof eventModule?.execute === 'function';

	if (!hasCall && !hasExecute) {
		return { error: 'Missing callable handler: expected `call` or `execute`' };
	}

	if (hasCall && hasExecute) {
		// Prefer call(...) for backward compatibility.
		return {
			handler: (...args) => eventModule.call(client, args),
			warning: 'Both `call` and `execute` were found; using `call`.'
		};
	}

	if (hasCall) {
		return {
			handler: (...args) => eventModule.call(client, args)
		};
	}

	return {
		handler: (...args) => eventModule.execute(...args, client)
	};
}

async function load(client) {
	const startTime = Date.now();
	let loadedCount = 0;
	let skippedCount = 0;
	let errorCount = 0;
	const warnings = [];
	const errors = [];
	const eventUsage = new Map();
	const perFileLoadTimes = [];
	const verbose = String(process.env.EVENTS_LOAD_VERBOSE || '').toLowerCase() === 'true';

	if (!client || typeof client.on !== 'function' || typeof client.once !== 'function') {
		throw new Error('Events loader requires a valid Discord client instance.');
	}

	if (client.events && typeof client.events.clear === 'function') {
		client.events.clear();
	}

	unregisterPreviousListeners(client);

	console.log(`\n${colors.cyan}${colors.bright}📡 Events${colors.reset} (loading...)`);

	for await (const fn of getFiles('./Events')) {
		if (fn.endsWith('_loader.js')) continue;
		if (!fn.endsWith('.js')) continue;

		const relFile = relative(process.cwd(), fn).replace(/\\/g, '/');

		try {
			const fileStart = Date.now();

			// Ensure runtime picks up file edits when reloaded.
			delete require.cache[require.resolve(fn)];
			const eventModule = require(fn);

			if (eventModule?.disabled === true) {
				skippedCount += 1;
				continue;
			}

			const eventName = String(eventModule?.name || '').trim();
			if (!eventName) {
				skippedCount += 1;
				warnings.push({ file: relFile, warning: 'Missing event `name`; file skipped' });
				continue;
			}

			const runOnce = Boolean(eventModule?.runOnce);
			const handlerInfo = getHandler(eventModule, client);
			if (handlerInfo.error) {
				throw new Error(handlerInfo.error);
			}
			if (handlerInfo.warning) {
				warnings.push({ file: relFile, warning: handlerInfo.warning });
			}

			const usageCount = Number(eventUsage.get(eventName) || 0) + 1;
			eventUsage.set(eventName, usageCount);
			if (usageCount > 1) {
				warnings.push({ file: relFile, warning: `Duplicate event name \`${eventName}\` registered (${usageCount})` });
			}

			registerTrackedListener(client, eventName, runOnce, handlerInfo.handler, relFile);

			if (client.events && typeof client.events.set === 'function') {
				client.events.set(relFile, {
					name: eventName,
					runOnce,
					source: relFile
				});
			}

			loadedCount += 1;
			perFileLoadTimes.push({ file: relFile, ms: Date.now() - fileStart });
		} catch (error) {
			errorCount += 1;
			errors.push({ file: relFile, error: error?.message || String(error) });
			console.log(`  ${colors.red}-${colors.reset} ${relFile}: ${colors.red}${error?.message || error}${colors.reset}`);
		}
	}

	loadedEventCount = loadedCount;
	const durationMs = Date.now() - startTime;
	const errorMsg = errorCount > 0
		? ` ${colors.yellow}(${errorCount} error${errorCount !== 1 ? 's' : ''})${colors.reset}`
		: '';
	const skipMsg = skippedCount > 0
		? ` ${colors.yellow}(${skippedCount} skipped)${colors.reset}`
		: '';

	console.log(`  ${colors.green}✅${colors.reset} ${loadedCount} loaded${errorMsg}${skipMsg} ${colors.dim}(${durationMs}ms)${colors.reset}`);

	if (warnings.length > 0) {
		console.log(`${colors.yellow}  Warnings:${colors.reset}`);
		warnings.forEach((item) => {
			console.log(`    • ${item.file}: ${colors.yellow}${item.warning}${colors.reset}`);
		});
	}

	if (errors.length > 0) {
		console.log(`${colors.red}  Failed:${colors.reset}`);
		errors.forEach((item) => {
			console.log(`    • ${item.file}: ${colors.red}${item.error}${colors.reset}`);
		});
	}

	if (verbose && perFileLoadTimes.length > 0) {
		const slowest = perFileLoadTimes
			.slice()
			.sort((a, b) => b.ms - a.ms)
			.slice(0, 5);

		console.log(`${colors.blue}  Slowest event loads:${colors.reset}`);
		slowest.forEach((item) => {
			console.log(`    • ${item.file}: ${item.ms}ms`);
		});
	}

	return {
		loaded: loadedCount,
		skipped: skippedCount,
		errors: errorCount,
		durationMs,
		warningList: warnings,
		errorList: errors
	};
}

module.exports = load;
module.exports.getEventCount = () => loadedEventCount;