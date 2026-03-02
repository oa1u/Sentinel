# Sentinel Discord Bot

Sentinel is a comprehensive, professional-grade solution for Discord server moderation and community management. It features an advanced ticket system, auto-moderation, leveling, a fully-featured Admin Panel web dashboard, and much more.

## 🚀 Setup & Installation

### Important: Enable Privileged Gateway Intents
Before your bot can function correctly, you **must enable Privileged Gateway Intents** in the Discord Developer Portal. Our bot's features (such as welcoming users, checking statuses, and managing tickets) require these extra intents.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application and click on **Bot** on the left menu.
3. Scroll down to the **Privileged Gateway Intents** section.
4. Toggle **ON** exactly these three settings:
   - ✅ **Presence Intent**
   - ✅ **Server Members Intent**
   - ✅ **Message Content Intent**
5. Save your changes!

### 📥 Inviting the Bot
To ensure the bot functions seamlessly with its advanced ticket, logging, and moderating features, you should invite it using the following links.

**Option 1: Administrator Permissions (Highly Recommended)**
This ensures the bot can manage channels for tickets, assign roles, kick/ban users, and delete messages without running into generic 'Missing Access' errors.
**🔗 [Invite Bot (Admin)](https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID_HERE&permissions=8&scope=bot%20applications.commands)**

**Option 2: Specific Permissions**
If you prefer not to grant Administrator, this link requests the specific granular permissions needed by the modules.
**🔗 [Invite Bot (Specific)](https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID_HERE&permissions=1384074218358&scope=bot%20applications.commands)**

*(Note: Replace `YOUR_CLIENT_ID_HERE` with your bot's Client ID from the Discord portal before clicking!)*

---

### ⚙️ Getting Started

1. Ensure Node.js (v18+) is installed.
2. Run `npm install` to download dependencies.
3. Configure your bot:
   - Ensure an environment file exists at `Config/credentials.env`. 
   - Ensure your `TOKEN`, `CLIENT_ID`, and `GUILD_ID` (your server ID) are set.
   - If using the Admin Panel, set up your OAuth credentials.
4. Start the bot by typing `node index.js` in the terminal.

### 📚 Admin Panel Help Pages

Once you're logged into the Admin Panel, you can use the built-in help pages to get set up faster:

- **Getting Started**: A guided setup flow for initial bot and panel configuration.
- **Features**: A complete overview of available bot and dashboard modules.
- **FAQ**: Quick answers to common setup and usage questions.

### 🐛 Troubleshooting
- **`Error registering commands: Missing Access`**: Make sure you have authorized the bot via an invite link that has the `applications.commands` scope (the ones provided above include it). Additionally, ensure your `GUILD_ID` in `.env` is correct.
- **Commands Not Responding/Crashing on Startup**: Re-check your **Privileged Gateway Intents** in the Discord Developer Portal.

### 🖼️ Screenshots

![Screenshot 1](githubimages/1.PNG)
![Screenshot 2](githubimages/2.PNG)
![Screenshot 3](githubimages/3.PNG)
![Screenshot 4](githubimages/4.PNG)
![Screenshot 5](githubimages/5.PNG)
![Screenshot 6](githubimages/6.PNG)
![Screenshot 7](githubimages/7.PNG)
![Screenshot 8](githubimages/8.PNG)
![Screenshot 9](githubimages/9.PNG)
