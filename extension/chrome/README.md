# LibreChat Assistant Chrome Extension

A Chrome extension that enhances your LibreChat experience by providing context from your browser tabs. Ask questions about any webpage you're viewing, and the assistant will use the page content to provide informed responses.

## Features

- 🔍 Extract readable content from any webpage
- 💬 Ask questions about the current page in a side panel
- 🔐 Secure authentication with your LibreChat instance
- 📝 Maintains conversation history during your session
- ⚡ Streaming responses for real-time interaction

## Prerequisites

- A running LibreChat instance (self-hosted or provided by your organization)
- Google Chrome or Chromium-based browser
- Access credentials for your LibreChat instance

## Installation

### 1. Configure Your LibreChat Domain

Before loading the extension, you need to replace the placeholder domain with your actual LibreChat instance URL.

**Files to update:**

1. **manifest.json** (lines 14 and 23)
   - Replace `https://REPLACE_ME.com/` with your LibreChat domain
   - Example: `https://chat.example.com/`

2. **background.js** (line 1)
   - Replace `https://REPLACE_ME.com` with your LibreChat domain (no trailing slash)
   - Example: `https://chat.example.com`

**Example:**
```javascript
// Before
const LIBRECHAT_URL = 'https://REPLACE_ME.com';

// After
const LIBRECHAT_URL = 'https://chat.example.com';
```

### 2. Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in the top-right corner)
3. Click "Load unpacked"
4. Select the folder containing this extension
5. The LibreChat Assistant icon should appear in your Chrome toolbar

## Usage

### First Time Setup

1. Navigate to your LibreChat instance in Chrome
2. Sign in with your credentials
3. Click the LibreChat Assistant icon in your Chrome toolbar

### Using the Assistant

1. **Open the side panel**: Click the LibreChat Assistant icon in your toolbar
2. **Navigate to any webpage**: The extension works on any page
3. **Ask questions**: Type your question in the text box and press Enter or click "Ask"
   - Example: "Summarize this page for me"
   - Example: "What are the main points in this article?"
   - Example: "Explain this concept in simple terms"
4. **Start new conversations**: Click "New Chat" to clear the conversation history

### Authentication

- The extension automatically manages authentication with your LibreChat instance
- If you see a "Reconnect to LibreChat" button, click it to refresh your session
- You'll need to be signed into LibreChat in a browser tab for the extension to work

## How It Works

1. **Content Extraction**: Uses Mozilla's Readability library to extract clean, readable content from web pages
2. **Context Provision**: Sends the page content (up to 10,000 characters) along with your question to LibreChat
3. **Streaming Responses**: Displays the AI response in real-time as it's generated
4. **Secure Communication**: Uses your LibreChat access token for authenticated API requests

## Permissions Explained

The extension requires the following permissions:

- **storage**: To cache your authentication token securely
- **cookies**: To manage session authentication with LibreChat
- **sidePanel**: To display the chat interface
- **scripting**: To extract content from web pages
- **activeTab**: To access the current page's content
- **host_permissions**: To communicate with your LibreChat instance

## Troubleshooting

### "Open your librechat site in a new tab to refresh your session"

- **Solution**: Open your LibreChat instance in a new tab and sign in

### "Token request failed. Log back into your librechat site"

- **Solution**: Navigate to your LibreChat instance and sign in again

### Extension not loading

- **Check**: Verify you've replaced all instances of `REPLACE_ME.com` with your actual domain
- **Check**: Ensure your LibreChat instance is accessible and running
- **Check**: Look for errors in Chrome DevTools (Extensions page > "Errors" button)

### "Could not read page content"

- Some pages may have restrictions that prevent content extraction
- Try refreshing the page and attempting again
- Chrome system pages (chrome://) cannot be accessed by extensions

## Privacy & Security

- ✅ No hardcoded credentials or API keys
- ✅ Authentication tokens stored securely in session storage
- ✅ All communication with your LibreChat instance uses HTTPS
- ✅ Page content is only sent when you explicitly ask a question
- ✅ No data is sent to third parties

## Development

### File Structure

```
.
├── manifest.json          # Extension configuration
├── background.js          # Service worker for API calls and auth
├── contentScript.js       # Handles token refresh from LibreChat page
├── sidepanel.html         # Side panel UI structure
├── sidepanel.css          # Side panel styling
├── sidepanel.js           # Side panel interaction logic
├── Readability.js         # Mozilla's content extraction library
└── README.md             # This file
```

### Key Components

- **background.js**: Manages authentication, token caching, and API communication
- **contentScript.js**: Injected into LibreChat pages to handle token refresh
- **sidepanel.js**: Handles user interactions and displays streaming responses

## License

This extension uses Mozilla's Readability library (https://github.com/mozilla/readability), which is licensed under the Apache License 2.0.

## Support

If you encounter issues:

1. Check the troubleshooting section above
2. Verify your LibreChat instance is accessible
3. Check the browser console for error messages
4. Ensure you're using a compatible version of LibreChat

---

**Note**: This extension requires a LibreChat instance to function. It does not work with other chat services.
