const mysqlConnection = require('../Functions/MySQLConnection');
const bcrypt = require('bcrypt');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise((resolve) => {
        rl.question(prompt, resolve);
    });
}

const EmailHelper = require('../Functions/EmailHelper');

async function isValidEmail(email) {
    return await EmailHelper.isValidEmail(email);
}

async function createAccount() {
    const args = process.argv.slice(2);

    // Check if arguments were provided (non-interactive mode)
    if (args.length >= 4) {
        const [username, password, role, email] = args;
        await createAccountNonInteractive(username, password, role, email);
        return;
    }

    // Interactive mode
    const connected = await mysqlConnection.connect();
    if (!connected) {
        console.error('❌ Failed to connect to MySQL');
        process.exit(1);
    }

    try {
        console.log('\n👤 Admin Account Creator\n');
        const websiteName = require('../Config/main.json').websiteName;
        console.log(`Creating a new ${websiteName} account...\n`);

        // Get input
        const username = await question('Enter username (3-32 characters): ');
        const email = await question('Enter email address: ');
        const password = await question('Enter password (min 6 characters): ');
        const confirmPassword = await question('Confirm password: ');

        console.log('\nSelect role:');
        console.log('  1. Owner    - Full access to everything');
        console.log('  2. Admin    - Manage users, view logs, moderate');
        console.log('  3. Moderator - Basic moderation tools\n');
        const roleChoice = await question('Enter choice (1-3): ');

        rl.close();

        // Validate inputs
        if (!username || username.length < 3 || username.length > 32) {
            console.error('❌ Username must be between 3 and 32 characters');
            process.exit(1);
        }

        if (!password || password.length < 6) {
            console.error('❌ Password must be at least 6 characters');
            process.exit(1);
        }

        if (!(await isValidEmail(email))) {
            console.error('❌ Please enter a valid email address');
            process.exit(1);
        }

        if (password !== confirmPassword) {
            console.error('❌ Passwords do not match');
            process.exit(1);
        }

        // Map choice to role
        const roleMap = {
            '1': 'owner',
            '2': 'admin',
            '3': 'moderator'
        };

        const role = roleMap[roleChoice];
        if (!role) {
            console.error('❌ Invalid role choice');
            process.exit(1);
        }

        await createAccountNonInteractive(username, password, role, email);

    } catch (error) {
        console.error('❌ Error creating account:', error);
        rl.close();
        process.exit(1);
    }
}

async function createAccountNonInteractive(username, password, role, email) {
    const connected = mysqlConnection.pool ? true : await mysqlConnection.connect();
    if (!connected) {
        console.error('❌ Failed to connect to MySQL');
        process.exit(1);
    }

    try {
        // Validate inputs
        if (!username || username.length < 3 || username.length > 32) {
            console.error('❌ Username must be between 3 and 32 characters');
            process.exit(1);
        }

        if (!password || password.length < 6) {
            console.error('❌ Password must be at least 6 characters');
            process.exit(1);
        }

        if (!isValidEmail(email)) {
            console.error('❌ Please provide a valid email address');
            process.exit(1);
        }

        const validRoles = ['owner', 'admin', 'moderator'];
        if (!validRoles.includes(role)) {
            console.error('❌ Role must be one of: owner, admin, moderator');
            process.exit(1);
        }

        // Check if username or email already exists
        const [existing] = await mysqlConnection.pool.execute(
            'SELECT username, email FROM admin_users WHERE username = ? OR email = ?',
            [username, email]
        );

        if (existing.length > 0) {
            const usernameExists = existing.some((row) => row.username === username);
            const emailExists = existing.some((row) => row.email === email);

            if (usernameExists) {
                console.error(`❌ Username '${username}' already exists`);
            }
            if (emailExists) {
                console.error(`❌ Email '${email}' is already in use`);
            }
            process.exit(1);
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // Insert user
        const { v7: uuidv7 } = require('uuid');
        const id = uuidv7();
        await mysqlConnection.pool.execute(
            'INSERT INTO admin_users (id, username, email, password_hash, role, active) VALUES (?, ?, ?, ?, ?, TRUE)',
            [id, username, email, passwordHash, role]
        );

        console.log('\n✅ Account created successfully!\n');
        console.log(`   👤 Username: ${username}`);
        console.log(`   📧 Email: ${email}`);
        console.log(`   🔑 Role: ${role.toUpperCase()}`);
        console.log(`   🔐 Password: [hidden]\n`);
        console.log('🌐 You can now log in at: http://localhost:3000/login\n');

    } catch (error) {
        console.error('❌ Error creating account:', error.message);
        process.exit(1);
    } finally {
        await mysqlConnection.pool.end();
        process.exit(0);
    }
}

// Show usage if --help is passed
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('\n👤 Admin Account Creator\n');
    console.log('📝 Usage:');
    console.log('   Interactive mode:');
    console.log('     node scripts/createAccount.js\n');
    console.log('   Non-interactive mode:');
    console.log('     node scripts/createAccount.js <username> <password> <role> <email>\n');
    console.log('   Roles: owner, admin, moderator\n');
    console.log('📋 Examples:');
    console.log('   node scripts/createAccount.js');
    console.log('   node scripts/createAccount.js johndoe password123 admin john@domain.com');
    console.log('   node scripts/createAccount.js alice secretpass owner alice@domain.com\n');
    process.exit(0);
}

createAccount();