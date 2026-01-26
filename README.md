# 🤖 Discord Bot

A feature-rich Discord moderation and management bot with ticket system, verification, and comprehensive logging.

---

## ⚠️ Disclaimer

This bot is actively under development and may contain bugs or incomplete features. Expect updates at some point, improvements, and fixes as development continues.

---

## ✨ Features

### 🛡️ Moderation
- **Ban/Kick/Warn** - Full moderation suite with case ID tracking
- **Warning System** - View warns by case ID or user
- **Clear Messages** - Bulk delete up to 100 messages
- **Delete Specific Messages** - Remove messages by link

### 🎫 Ticket System
- **Create Tickets** - Users can open support tickets with reasons
- **Close Tickets** - `/close` command or ❌ reaction
- **Mark Handled** - Support team can flag resolved tickets

### 🔐 Verification
- **Captcha System** - Auto-verify new members with captcha challenges
- **Manual Verify** - `/verify` command for users that joined with DM's disabled
- **Welcome Canvas** - Custom welcome images for verified members

### 📊 Logging
Comprehensive event logging for:
- Channel events (create, delete, update)
- Emoji events (create, delete, update)
- Member events (join, leave, update)
- Invite events (create, delete)
- Role events (create, delete, update)

### ⚙️ Management
- **Announcements** - announcements
- **Unban** - Remove bans by user ID
- **Clear Warnings** - Remove specific warnings by case ID
- **Check Ban** - Lookup ban details by case ID

### 🔧 Utility
- **User Info** - Detailed user information with roles, permissions, and account age
- **Help** - Dynamic help menu with role-based filtering

---

## 🚀 Setup Instructions

### 1️⃣ Install Dependencies
```bash
npm install
```

### 2️⃣ Configure the Bot
Fill in all required values in the `/Config` folder:
- `credentials.env` - Bot token and API keys
- `main.json` - Server settings
- `presence.json` - Bot presence/status
- `constants/` - Channel IDs, role IDs, and other constants

> **Note:** Some config options are placeholders and will be implemented or removed in future updates.

### 3️⃣ Register Commands
```bash
node register-commands.js
```

### 4️⃣ Start the Bot
```bash
node index.js
```

If everything is configured correctly, your bot should now be online! 🎉

---

## 🛠️ To-Do List

- [ ] Server Info command
- [ ] Giveaway system
- [ ] "Join to Create" voice channel system
- [ ] Timeout & Un-timeout commands
- [ ] Add more fun/entertainment commands
- [ ] Add code comments for better documentation
- [ ] Refactor constant naming conventions
- [ ] Auto Mod
- [ ] Update the descriptions for the commands
- [ ] See if i can figure out a way to unban a user using the case ID instead of user ID
- [ ] Try to compact the config folder
- [x] ~~Checkban command (by case ID)~~ ✅
- [x] ~~Add verify command~~ ✅
- [x] ~~Update embeds~~ ✅
- [x] ~~Fix ticket closing with ❌ reaction~~ ✅
- [x] ~~Fix logging system~~ ✅

---

## 🐞 Known Issues

The warning system is currently buggy, will be updated soon

If you discover any bugs, please report them in the Issues tab.

---

## 📦 Commands Overview

### Moderation (Requires Moderator Role)
| Command | Description |
|---------|-------------|
| `/ban` | Ban a user with reason tracking |
| `/kick` | Kick a user with reason tracking |
| `/warn` | Warn a user with case logging |
| `/clear` | Bulk delete messages (up to 100) |
| `/deletemsg` | Delete a specific message by link |
| `/warning` | View warning details by case ID |
| `/warns` | View all warnings for a user |

### Management (Requires Admin Role)
| Command | Description |
|---------|-------------|
| `/announce` | Send a regular announcement |
| `/eannounce` | Send an everyone announcement |
| `/unban` | Unban a user by ID |
| `/clearwarns` | Clear a specific warning by case ID |
| `/checkban` | Lookup ban information by case ID |
| `/verify` | Allows a user to verify themselves |

### Ticket System
| Command | Description |
|---------|-------------|
| `/ticket` | Create a new support ticket |
| `/close` | Close the current ticket |
| `/markhandled` | Mark ticket as handled (Support role) |

### Utility
| Command | Description |
|---------|-------------|
| `/userinfo` | Display detailed user information |
| `/help` | Show all available commands |

---

## 🧩 Support & Contributions

### 🐛 Found a Bug?
If you encounter any bugs or issues:
1. Open an issue in the **Issues** tab
2. Provide detailed steps to reproduce
3. Include any error messages or screenshots

### 💡 Feature Requests
Have an idea for a new feature? Feel free to suggest it in the Issues tab!

### 🤝 Contributing
Contributions are welcome! If you'd like to improve the bot, feel free to fork the repository and submit a pull request.

---

## 📝 License

This project is open source and available for personal and educational use.

---

**Made with ❤️ for Discord communities**
**ReadMe.MD was created by ChatGPT**