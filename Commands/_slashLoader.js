const { resolve } = require("path");
const { readdir } = require("fs").promises;
const { Collection } = require("discord.js");

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
	const startTime = Date.now();
	let commandCount = 0;
	let errorCount = 0;
	const categories = new Map();
	const errors = [];
	
	console.log(`\n${colors.cyan}${colors.bright}🎮 Commands${colors.reset} (loading...)`);
	
	for await (const fn of getFiles("./Commands")) {
		if (fn.endsWith("_loader.js") || fn.endsWith("_slashLoader.js")) continue;
		
		try {
			const command = require(fn);
			
			// Validate command has required data
			if (!command.data) {
				throw new Error('Missing "data" property (SlashCommandBuilder)');
			}
			if (!command.execute) {
				throw new Error('Missing "execute" function');
			}
			
			const cmdName = command.data.name;
			const category = command.category || 'uncategorized';
			
			collection.set(cmdName, command);
			
			if (!categories.has(category)) {
				categories.set(category, []);
			}
			categories.get(category).push(cmdName);
			
			commandCount++;
		} catch (err) {
			errorCount++;
			const cmdPath = fn.split('\\').pop();
			errors.push({ file: cmdPath, error: err.message });
			console.log(`  ${colors.red}❌${colors.reset} ${fn.split('\\').pop()}: ${colors.red}${err.message}${colors.reset}`);
		}
	}
	
	const loadTime = Date.now() - startTime;
	
	// Single line summary
	const categoryList = Array.from(categories.keys()).join(', ');
	const errorMsg = errorCount > 0 ? ` ${colors.yellow}(${errorCount} error${errorCount !== 1 ? 's' : ''})${colors.reset}` : '';
	console.log(`  ${colors.green}✅${colors.reset} ${commandCount} commands in ${categories.size} categories${errorMsg} ${colors.dim}(${loadTime}ms)${colors.reset}`);
	
	if (errorCount > 0) {
		console.log(`${colors.red}  Failed:${colors.reset}`);
		errors.forEach((err) => {
			console.log(`    • ${err.file}: ${colors.red}${err.message}${colors.reset}`);
		});
	}
}

module.exports = load;