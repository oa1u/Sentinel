<div align="center">

# 🤖 OA1U Discord Bot

### *Enterprise-Grade Discord Moderation & Community Management Suite*

[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue.svg?style=for-the-badge&logo=discord)](https://discord.js.org/)
[![Node.js](https://img.shields.io/badge/node.js-v18+-green.svg?style=for-the-badge&logo=nodedotjs)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Open%20Source-orange.svg?style=for-the-badge)](LICENSE)

**Powerful Moderation** • **Advanced Ticket System** • **Smart Auto-Moderation** • **XP Leveling** • **Comprehensive Audit Logging** • **Fun Engagement Features**

</div>

---

## 📋 Table of Contents

- [⚡ Overview](#-overview)
- [✨ Core Features](#-core-features)
- [🛠️ Tech Stack](#️-tech-stack)
- [🚀 Quick Start](#-quick-start)
- [📦 Command Reference](#-command-reference)
- [⚙️ Configuration Guide](#️-configuration-guide)
- [🗺️ Development Roadmap](#️-development-roadmap)
- [🐞 Known Issues](#-known-issues)
- [🤝 Support & Contributing](#-support--contributing)
- [📝 License](#-license)

---

## ⚡ Overview

**OA1U** is a comprehensive Discord bot engineered for modern community servers. It combines powerful moderation tools, professional support systems, engaging gamification, and intelligent automation into a single, cohesive package.

Whether you're managing a small community or a large gaming server, OA1U provides the tools you need to maintain order, engage your members, and scale your moderation efforts effortlessly.

### 🎯 Why Choose OA1U?

| Feature | Benefit |
|---------|---------|
| **Case-Tracked Moderation** | Every action is logged with unique case IDs for complete audit trails |
| **Smart Auto-Moderation** | Intelligent filtering that learns from your configuration |
| **Ticket System** | Professional support workflow with claim management and routing |
| **XP Leveling** | Gamify engagement and reward active community members |
| **Comprehensive Logging** | Track 15+ types of server events automatically |
| **Production-Ready** | Actively maintained with regular updates and bug fixes |

> ✨ **Status:** Actively maintained and continuously improved with community feedback.

---

## 🛠️ Tech Stack

Built with modern, battle-tested technologies:

- **Runtime:** Node.js v18+
- **Library:** Discord.js v14 (latest Discord API)
- **Database:** JSON-based configuration (easily expandable to MongoDB/PostgreSQL)
- **Architecture:** Modular command system with event-driven design
- **Code Style:** JavaScript ES6+ with async/await patterns

---

## ✨ Core Features

<details open>
<summary><b>🛡️ Advanced Moderation System</b></summary>

**Complete case management with audit trails:**

- **User Management:** Ban, kick, timeout, and warn users with automatic case ID tracking
- **Warning System:** View detailed warning history by user or case ID, clear specific warnings
- **Case Lookup:** Reference past cases for context and historical decisions
- **Unban System:** Unban users with case reference lookup and documentation
- **Message Control:** Bulk message deletion (up to 100 messages) and delete specific messages via link
- **Action Logging:** Every moderation action is logged to designated audit channels

</details>

<details open>
<summary><b>🎫 Professional Ticket System</b></summary>

**Enterprise-grade support workflow:**

- **User-Friendly Creation:** One-click ticket creation with embedded button interfaces
- **Claim/Assignment:** Support team can claim tickets for organized workflow
- **User Management:** Add/remove members from tickets dynamically
- **Status Tracking:** Mark tickets as handled for dashboard statistics
- **Reaction Controls:** Quick close functionality with ❌ reaction
- **Complete Logging:** All ticket interactions are recorded and auditable

</details>

<details open>
<summary><b>🤖 Smart Auto-Moderation</b></summary>

**Intelligent, configurable content filtering:**

- **Blocked Words:** Automatic detection of configured phrases and slurs
- **Invite Protection:** Filter external Discord invites while allowing your own server link
- **Spam Detection:** Mass mention protection and duplicate message detection
- **Smart Notifications:** Enhanced DM alerts (with channel fallback for disabled DMs)
- **Visual Feedback:** Beautiful embed notifications for users and moderators
- **Automatic Actions:** Instant message deletion with detailed logging

</details>

<details open>
<summary><b>📈 XP & Leveling System</b></summary>

**Gamification and community engagement:**

- **Automatic XP Gain:** Members earn XP naturally from server participation
- **Customizable Rewards:** Configure level-up role assignments and rewards
- **Interactive Leaderboard:** Ranked leaderboards with pagination and pretty formatting
- **Admin Controls:** Manually set/reset user levels and XP balances
- **Progress Tracking:** Detailed rank cards showing progress to next level
- **Multipliers:** Support for XP multiplier events and role-based bonuses

</details>

<details>
<summary><b>📊 Comprehensive Audit Logging</b></summary>

**Track 15+ types of server events automatically:**

- **Member Events:** Join/leave tracking with account age and metadata
- **Role Changes:** Creation, deletion, modifications, and assignments
- **Channel Management:** Channel creation, deletion, and configuration updates
- **Emoji Tracking:** Emoji creation, deletion, and modifications
- **Message Audit:** Edits and deletions with content preservation
- **Invite Management:** Invite creation and deletion tracking
- **Server Updates:** Guild configuration and settings changes
- **Real-time Alerts:** All events logged to dedicated channels with timestamps

</details>

<details>
<summary><b>⚙️ Server Management Tools</b></summary>

**Administrative utilities and community management:**

- **Announcements:** Regular and @everyone announcements with formatting
- **Verification System:** Member verification workflow for access control
- **Giveaways:** Timed giveaway system with automatic winner selection
- **Voice Channel Creation:** Join-to-Create voice channels with auto-cleanup
- **Server Info:** Comprehensive server statistics and member information
- **Member Tools:** User lookup, role assignment, and account information

</details>

<details>
<summary><b>🎮 Fun & Engagement Features</b></summary>

**Keep your community entertained:**

- **Magic 8-Ball:** Consult the oracle for yes/no questions
- **Trivia:** Multi-category trivia challenges with scoring
- **Coin Flip:** Simple probability games for decision-making
- **Random Facts:** Educational and entertaining facts
- **Jokes & Roasts:** Dynamic humor generation
- **Pickup Lines:** Lighthearted ice-breaker generation
- **Interactive Polls:** Create polls with reaction-based voting
- **Reminders:** Personal reminder system via DM

</details>

<details>
<summary><b>🔧 Utility & Information Commands</b></summary>

**Practical tools for daily use:**

- **Cryptocurrency Prices:** Real-time crypto price lookups
- **Dictionary Definitions:** Word definitions with phonetic pronunciation
- **Help System:** Comprehensive command documentation
- **Statistics:** Detailed user and server information displays

</details>

---

## 🚀 Quick Start

### 📋 Prerequisites

Before you begin, ensure you have:
- **Node.js v18 or higher** - [Download here](https://nodejs.org/)
- **Discord Bot Token** - [Create one here](https://discord.com/developers/applications)
- **Administrator access** to a Discord test server
- **Basic terminal/command line knowledge**

### 📥 Installation Steps

#### 1️⃣ Clone the Repository
```bash
git clone https://github.com/oa1u/oa1u-bot.git
cd oa1u-bot
```

#### 2️⃣ Install Dependencies
```bash
npm install
```

This installs all required packages:
- `discord.js` - Discord API library
- Additional utilities and APIs for fun commands

#### 3️⃣ Configure the Bot

Navigate to the `/Config` directory and set up these essential files:

**`credentials.env`** - Bot Authentication
```env
TOKEN=your_discord_bot_token_here
```

**`main.json`** - Core Server Configuration
```json
{
  "guildId": "your_server_id",
  "links": {
    "invite": "https://discord.gg/yourlink"
  }
}
```

**`presence.json`** - Bot Status Display
```json
{
  "status": "online",
  "activity": {
    "name": "/help | Helping communities",
    "type": "WATCHING"
  }
}
```

**`constants/` Directory** - Advanced Configuration

| File | Purpose |
|------|---------|
| `channel.json` | Log channels, ticket channels, and notification destinations |
| `roles.json` | Moderator, admin, and special role IDs for permission checks |
| `leveling.json` | XP rates, level thresholds, and reward roles |
| `blockedWords.json` | Words/phrases to filter in auto-moderation |
| `api.json` | API keys for external services (crypto, definitions, etc.) |
| `misc.json` | Miscellaneous settings and feature toggles |

#### 4️⃣ Start the Bot
```bash
node index.js
```

You should see a colorful startup message listing all loaded commands and events. ✅

#### 5️⃣ Test in Discord
```
/help
```

Run this command in your server to verify everything is working!

### 💡 Configuration Best Practices

- **Use Discord Developer Mode** to easily copy IDs (User Settings → Advanced → Developer Mode)
- **Set up dedicated channels** for logs to keep your server organized
- **Review blocked words** regularly to match your community standards
- **Test moderation commands** in a private channel first
- **Configure role hierarchy** to match your server's moderation structure

---

## ⚙️ Configuration Guide

### 📂 Config File Structure

```
Config/
├── credentials.env           # Bot token (KEEP SECRET!)
├── main.json                 # Server and guild settings
├── presence.json             # Bot activity and status
└── constants/
    ├── api.json              # External API credentials
    ├── blockedWords.json     # AutoMod filter list
    ├── channel.json          # Channel ID mappings
    ├── leveling.json         # XP and level settings
    ├── misc.json             # Miscellaneous toggles
    └── roles.json            # Role ID mappings
```

### 🔐 Security Notes

⚠️ **IMPORTANT:** 
- Never commit `credentials.env` to version control
- Use `.gitignore` to exclude sensitive files
- Regularly rotate your bot token if exposed
- Store API keys in environment variables, not in JSON files

---

## 📦 Command Reference

> 📌 **Note:** Some commands require specific roles (Moderator/Admin) as configured in your `roles.json` file. The bot will automatically handle permission checks.

### 🛡️ Moderation Commands
*Requires Moderator role*

| Command | Description | Example |
|---------|-------------|---------|
| `/ban` | Ban a user with reason tracking | `/ban @user Spamming` |
| `/kick` | Kick a user with reason tracking | `/kick @user Toxic behavior` |
| `/timeout` | Timeout (mute) user for duration | `/timeout @user 1h Disruption` |
| `/untimeout` | Remove timeout from a user | `/untimeout @user` |
| `/warn` | Warn a user with case logging | `/warn @user No spam` |
| `/clear` | Bulk delete messages | `/clear 10` |
| `/deletemsg` | Delete a message by link | `/deletemsg [link]` |
| `/warning` | View warning by case ID | `/warning CID-123` |
| `/warns` | View all warnings for user | `/warns @user` |
| `/clearwarning` | Clear specific warning | `/clearwarning CID-123` |
| `/clearwarns` | Clear all warnings | `/clearwarns @user` |

### ⚙️ Management Commands
*Requires Admin role*

| Command | Description | Example |
|---------|-------------|---------|
| `/announce` | Send announcement to channel | `/announce #general Hello team` |
| `/eannounce` | Send @everyone announcement | `/eannounce #announcements Update` |
| `/giveaway` | Create timed giveaway | `/giveaway "Steam Gift" 1d 2` |
| `/setlevel` | Set user level or XP | `/setlevel @user level 10` |
| `/unban` | Unban user by case ID | `/unban CID-456` |
| `/checkban` | Lookup ban information | `/checkban CID-456` |
| `/manage` | General management options | `/manage` |

### 🎫 Ticket System
*Available to everyone*

| Command | Description | Who Can Use |
|---------|-------------|-------------|
| `/ticket` | Create support ticket | Anyone |
| `/close` | Close current ticket | Anyone |
| `/claim` | Claim ticket | Support Staff |
| `/markhandled` | Mark as handled | Support Staff |
| `/adduser` | Add member to ticket | Support Staff |
| `/removeuser` | Remove member access | Support Staff |

### 📈 Leveling Commands
*Available to everyone*

| Command | Description |
|---------|-------------|
| `/rank` | View your/another user's level card |
| `/leaderboard` | View server XP leaderboard |

### 🎮 Fun Commands
*No permissions required*

| Command | Description | Cooldown |
|---------|-------------|----------|
| `/8ball` | Magic 8-ball predictions | 3s |
| `/trivia` | Answer trivia questions | 5s |
| `/coinflip` | Flip a coin | 3s |
| `/joke` | Get a random joke | 5s |
| `/fact` | Receive random facts | 5s |
| `/pickup` | Get pickup lines | 5s |
| `/roast` | Get roasted | 3s |

### 🔧 Utility Commands
*No permissions required*

| Command | Description | Example |
|---------|-------------|---------|
| `/help` | Show all commands | `/help` |
| `/userinfo` | Display user info | `/userinfo @user` |
| `/serverinfo` | Display server stats | `/serverinfo` |
| `/define` | Look up definitions | `/define "awesome"` |
| `/crypto` | Get crypto prices | `/crypto BTC` |
| `/poll` | Create a poll | `/poll "Question"` |
| `/remind` | Schedule reminder | `/remind "Event" 2h` |

### ✅ Verification Commands

| Command | Description |
|---------|-------------|
| `/verify` | Verify for server access |

---

## 🗺️ Development Roadmap

### � Planned Features (v2.0+)

- [ ] **Web Dashboard** - Real-time analytics and management console
- [ ] **Unified History** - View all moderation actions in one command (warns, mutes, kicks, bans)
- [ ] **Auto-Responses** - Create custom triggers for automatic responses
- [ ] **Permission System** - Granular, per-command permission control
- [ ] **Voice Channel Enhancement** - Advanced Join-to-Create features (naming templates, limits, etc.)
- [ ] **Reaction Roles** - Message-based role assignment
- [ ] **Music Integration** - Queue and play music in voice channels
- [ ] **Custom Commands** - Allow server admins to create custom commands
- [ ] **Advanced Analytics** - Member activity tracking and insights

### ✅ Recently Completed Features

- ✅ Colorful console startup with command/event summaries
- ✅ Enhanced auto-mod filter with DM notifications
- ✅ Private notifications with channel fallback
- ✅ Comprehensive server information command
- ✅ Automated giveaway system
- ✅ Join-to-Create voice channels
- ✅ Timeout/untimeout commands
- ✅ Expanded fun command collection
- ✅ Invite/spam auto-moderation
- ✅ Case ID tracking system
- ✅ Verification system
- ✅ Professional ticket system
- ✅ 15+ event logging types

---

## 🐞 Known Issues & Troubleshooting

### Current Status
✅ **No major known issues!** The bot is stable and production-ready.

### Common Issues & Solutions

#### ❌ Bot doesn't respond to commands
- **Check:** Bot has permission to send messages in the channel
- **Check:** Bot role is above user's role hierarchy (for moderation)
- **Solution:** Run `/help` to verify bot is online
- **Solution:** Check bot logs for permission errors

#### ❌ Moderation commands don't work
- **Issue:** Likely missing role configuration
- **Solution:** Set up `roles.json` with your admin/moderator role IDs
- **Solution:** Verify bot has "Administrator" or required permissions

#### ❌ Logging not showing up
- **Check:** Channel IDs in `channel.json` are correct
- **Check:** Bot has permission to send messages in log channels
- **Solution:** Enable Discord Developer Mode and copy IDs correctly

#### ❌ AutoMod not filtering messages
- **Check:** Blocked words are in `blockedWords.json`
- **Check:** Bot has message permission
- **Solution:** Verify JSON syntax in blockedWords.json
- **Solution:** Restart bot after config changes

### 📝 Reporting Issues

Found a bug? Help us improve:

1. **Gather Information:**
   - Bot version (check `package.json`)
   - Discord.js version
   - Node.js version
   - Command that failed
   - Full error message/screenshot

2. **Create Detailed Report:**
   - Clear description of the problem
   - Step-by-step reproduction steps
   - Expected vs actual behavior
   - Relevant error logs

3. **Open an Issue:**
   - Go to GitHub Issues
   - Include all information above
   - Add `bug` label for quick triage

---

## 🤝 Support & Contributing

### 💬 Need Help?

- **Documentation:** Check this README first
- **Common Issues:** See [Known Issues](#-known-issues--troubleshooting) section
- **Community:** Join our Discord for support
- **Issues:** Open a GitHub issue with detailed information

### 🐛 Found a Bug?

Open an issue with:
1. **Clear description** of what went wrong
2. **Steps to reproduce** the problem
3. **Expected vs actual behavior**
4. **Error logs/screenshots** if applicable
5. **Your configuration** (without sensitive data)

### 💡 Have a Feature Idea?

We'd love your suggestions!

1. Check if feature is on [Roadmap](#-development-roadmap)
2. Open an issue with `enhancement` label
3. Describe the feature and its benefits
4. Provide use cases or examples

### 🔧 Want to Contribute Code?

All contributions are welcome! Here's how:

1. **Fork** the repository
   ```bash
   git clone https://github.com/oa1u/oa1u-bot.git
   cd oa1u-bot
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b feature/YourAmazingFeature
   ```

3. **Make your changes**
   - Follow existing code style
   - Add comments for complex logic
   - Test thoroughly

4. **Commit your work**
   ```bash
   git commit -m "Add: YourAmazingFeature"
   ```

5. **Push to your fork**
   ```bash
   git push origin feature/YourAmazingFeature
   ```

6. **Open a Pull Request**
   - Describe what your PR does
   - Reference related issues
   - Be ready for feedback and improvements

### 📖 Contribution Guidelines

- **Code Style:** Follow existing patterns and conventions
- **Comments:** Add meaningful comments for clarity
- **Testing:** Test your changes before submitting
- **Documentation:** Update README if adding features
- **Commits:** Use clear, descriptive commit messages

---

## 📝 License

This project is **open source** and available for personal and educational use.

Users are permitted to:
- ✅ Use the bot in private servers
- ✅ Modify the code for personal use
- ✅ Study and learn from the codebase
- ✅ Contribute improvements back

Users should:
- ⚠️ Provide proper attribution if distributing
- ⚠️ Keep sensitive credentials private
- ⚠️ Respect Discord Terms of Service

For full license details, see the LICENSE file in the repository.

---

<div align="center">

## Made with ❤️ for Discord Communities

### Support OA1U

If you find this bot helpful and useful in your server, please consider:

- ⭐ **Starring** this repository on GitHub
- 🐛 **Reporting bugs** to help improve the project
- 💡 **Contributing features** to make it even better
- 📣 **Sharing** with other server admins

[![GitHub stars](https://img.shields.io/github/stars/oa1u/oa1u-bot?style=social&label=Star+Us)](https://github.com/oa1u/oa1u-bot)

### Quick Links
- 🔗 [GitHub Repository](https://github.com/oa1u/oa1u-bot)
- 📖 [Full Documentation](./README.md)
- 🐛 [Report Issues](https://github.com/oa1u/oa1u-bot/issues)
- 💬 [Discord Community](https://discord.gg/yourlink)

---

**Last Updated:** January 2026  
**Status:** ✅ Actively Maintained

**Readme.MD was made by ChatGPT**

</div>