# 🔊 Sound Tap

A simple, local sound player website for managing and playing multiple audio files with advanced controls.

## Features

- ✨ **Simple UI** optimized for desktop use
- 🎵 **Multiple playback modes**: Play exclusively (stop others) or additively (mix sounds)
- ⏸️ **Full control**: Play, pause, and stop individual sounds
- 🔄 **Loop control**: Set per file in JSON or toggle in UI
- 🔊 **Volume control**: Global volume + individual volume per sound
- 🛑 **Stop all**: Quick button to stop all playing sounds
- 📱 **Local files**: Works completely offline with local audio files

## Setup

### ⚠️ Important: Web Server Required

Due to browser CORS security restrictions, you **must** run a local web server. You cannot simply open `index.html` directly in your browser.

1. **Start a local web server** in the `sound-tap` directory:

   ```bash
   # Using Python 3 (most common)
   python3 -m http.server 8000
   
   # Using Python 2 (if Python 3 not available)
   python -m SimpleHTTPServer 8000
   
   # Using Node.js (if installed)
   npx http-server
   
   # Using PHP (if available)
   php -S localhost:8000
   ```

2. **Open in browser**: Visit **http://localhost:8000**

3. **Add your sound files** to the `sounds/` directory
   - Supported formats: MP3, WAV, OGG, M4A
   - Any audio format supported by your browser
   - ⚠️ **Note**: Audio files are git-ignored, so add your own files locally

4. **Configure sounds** in `sounds.json`:
   ```json
   {
     "globalVolume": 80,
     "sounds": [
       {
         "name": "My Cool Sound",
         "file": "sounds/my-sound.mp3",
         "loop": false,
         "volume": 80
       },
       {
         "name": "Background Music",
         "file": "sounds/background.wav", 
         "loop": true,
         "volume": 60
       }
     ]
   }
   ```

## Usage

### Playing Sounds
- **▶️ Play (Stop Others)**: Stops all other sounds and plays this one
- **➕ Play (Add)**: Plays this sound while keeping others running

### Controls
- **⏸️ Pause**: Pauses the sound (can resume from same position)  
- **⏹️ Stop**: Stops and resets the sound to beginning
- **🔄 Loop**: Toggle whether the sound should loop when it ends
- **🔊 Volume**: 
  - **Global Volume**: Affects all sounds (master volume control)
  - **Individual Volume**: Per-sound volume that combines with global volume
- **🛑 Stop All**: Stops all currently playing sounds

### Status Indicators
Each sound tile shows its current status through background color changes:
- **White background**: Ready or playing
- **Light gray**: Loading
- **Light yellow**: Paused  
- **Light red**: Error (file not found or other issues)

## File Structure

```
sound-tap/
├── index.html          # Main website file
├── style.css           # Styling
├── script.js           # JavaScript functionality  
├── sounds.json         # Sound configuration
├── .gitignore          # Git ignore rules (excludes audio files)
├── sounds/             # Directory for your audio files (git-ignored)
│   ├── .gitkeep        # Keeps directory in git
│   ├── Artesia.mp3     # Your audio files (not in git)
│   ├── file1.mp3       # Your audio files (not in git)
│   └── Pop.m4a         # Your audio files (not in git)
└── README.md           # This file
```

## JSON Configuration

The `sounds.json` file defines your available sounds:

```json
{
  "globalVolume": 80,
  "sounds": [
    {
      "name": "Display name for the sound",
      "file": "sounds/filename.mp3",  
      "loop": true or false,
      "volume": 80
    }
  ]
}
```

### Properties:
- **globalVolume**: Master volume level (0-100, defaults to 80 if not specified) - **Changes saved to localStorage!**
- **name**: Display name shown in the UI
- **file**: Path to the audio file (relative to the website)
- **loop**: Whether the sound should loop by default - **Changes saved to localStorage!**
- **volume**: Default volume level (0-100, defaults to 80 if not specified) - **Changes saved to localStorage!**

### How Settings Work:
1. **Initial load**: Values from `sounds.json` are used as defaults
2. **User changes**: Any volume or loop adjustments are saved to browser's localStorage  
3. **Next session**: localStorage values override JSON defaults
4. **Reset to defaults**: Clear localStorage to return to JSON settings

### Volume Behavior:
The final volume for each sound is calculated as: **Global Volume × Individual Volume**

For example:
- Global Volume: 80% 
- Individual Volume: 60%
- Final Volume: 80% × 60% = 48%

This allows you to:
- Use global volume as a master control
- Set individual sounds relatively quieter/louder
- Quickly adjust all sounds together with global volume

## Technical Details

- Built with vanilla HTML, CSS, and JavaScript
- Uses HTML5 Audio API for sound playback
- Responsive design (works on smaller screens too)
- No external dependencies
- Completely client-side (no server required)

## Browser Compatibility

Works in all modern browsers that support:
- HTML5 Audio API
- ES6+ JavaScript features
- CSS Grid and Flexbox

## Quick Start

### Standard Setup (Recommended)

1. Navigate to the `sound-tap` directory
2. Start the web server: `python3 -m http.server 8000`
3. Open **http://localhost:8000** in your browser
4. Add your audio files to the `sounds/` folder
5. Update `sounds.json` with your file details (including volume levels)
6. Use global volume to control overall loudness, individual sliders for balance

**✨ Smart Persistence Features:**
- **JSON file provides defaults** - Set your preferred initial volumes and loop settings
- **localStorage saves changes** - Any adjustments you make are automatically saved in your browser
- **Settings persist between sessions** - Your customizations survive browser refreshes and restarts
- **Easy reset option** - One-click button to restore all settings to JSON defaults
- **Export functionality** - Download your current settings as a timestamped JSON file
- **No complex server needed** - Works with any basic web server

## Quick Command Reference

### Start Web Server
```bash
cd sound-tap
python3 -m http.server 8000
```
**Features**: Full functionality with localStorage persistence

### Alternative Server Options
```bash
# Using Node.js (if installed)
npx http-server -p 8000

# Using PHP (if installed) 
php -S localhost:8000
```

### Fix Port Conflicts
```bash
# Find what's using port 8000
lsof -ti :8000

# Kill the process (replace XXXX with the process ID)  
kill XXXX

# Then start the server
python3 -m http.server 8000
```

### Settings Management

**Export Your Settings:**
- Click the "📥 Export Settings" button at the bottom of the page
- Downloads a timestamped JSON file with your current configuration
- Use this to backup your settings or share configurations

**Reset All Settings:**

*Using the Reset Button (Easy Way):*
- Click the "🔄 Reset All Settings" button at the bottom of the page
- Confirm the action in the dialog
- Page will automatically reload with JSON defaults

*Using Browser Console (Manual Way):*
```javascript
localStorage.removeItem('soundTapSettings')
```
Then refresh the page to use JSON defaults.

**Import Settings:**
- Replace your `sounds.json` file with an exported settings file
- Restart the server to load the new defaults

**What Gets Exported:**
```json
{
    "globalVolume": 85,
    "sounds": [
        {
            "name": "Artesia",
            "file": "sounds/Artesia.mp3",
            "loop": true,
            "volume": 90
        }
    ]
}
```
- Current global volume setting
- All individual sound volumes
- All loop states
- Filename with timestamp: `sound-tap-settings-2025-01-15T10-30-00.json`

## Troubleshooting

### Server Issues

**Getting "Port 8000 is already in use" error?**
- You have another server running on port 8000
- **Stop the old server first**:
  1. Find the process: `lsof -ti :8000`
  2. Kill it: `kill [process_id]`
  3. Then start the server: `python3 -m http.server 8000`

**Server won't start or crashes?**
- Make sure you're in the `sound-tap` directory
- Check that `sounds.json` and `index.html` are present
- Try a different port: `python3 -m http.server 8001` then visit `http://localhost:8001`

### General Issues

**Getting CORS errors or "Failed to load" messages?**
- ⚠️ **Most common issue**: You must use a web server! Don't open `index.html` directly
- Start a local server (basic: `python3 -m http.server 8000` or enhanced: `python3 server.py`)
- Access via **http://localhost:8000** (not file://)

**Sounds not loading?**
- Check that file paths in `sounds.json` are correct
- Ensure audio files are in the `sounds/` directory
- Verify the web server is running and accessible

**No sound playing?**
- Check browser console for error messages
- Verify audio file format is supported by your browser
- Ensure browser isn't muted or volume is up

**UI not updating?**
- Hard refresh the page (Ctrl+F5 or Cmd+Shift+R)
- Check browser console for JavaScript errors

**Settings not persisting between sessions?**
- **Check localStorage**: Open browser console and run `localStorage.getItem('soundTapSettings')` - should show your saved settings
- **Private/Incognito mode**: localStorage is cleared when you close private browsing windows
- **Browser storage issues**: Try `localStorage.removeItem('soundTapSettings')` then refresh to reset
- **Check console**: Look for "✅ Settings saved to localStorage" messages when you change settings

**Settings reset unexpectedly?**
- **Browser cleared storage**: Check if your browser's privacy settings clear localStorage
- **Different browser/device**: Settings are stored per-browser, not shared between devices
- **File protocol**: Make sure you're using `http://localhost:8000`, not opening `file://` directly

---

Enjoy your Sound Tap experience! 🎵
