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
- **name**: Display name shown in the UI
- **file**: Path to the audio file (relative to the website)
- **loop**: Whether the sound should loop by default
- **volume**: Default volume level (0-100, defaults to 80 if not specified)

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

### Option 1: Enhanced Server (Recommended - with JSON persistence)

1. Navigate to the `sound-tap` directory
2. Start the enhanced server: `python3 server.py`
3. Open **http://localhost:8000** in your browser
4. Add your audio files to the `sounds/` folder
5. Update `sounds.json` with your file details (including volume levels)
6. Use global volume to control overall loudness, individual sliders for balance

**✨ Enhanced Features:**
- Loop setting changes are automatically saved to `sounds.json`
- Settings persist between browser refreshes
- Real-time save notifications

### Option 2: Basic Static Server (Read-only)

1. Navigate to the `sound-tap` directory  
2. Start basic server: `python3 -m http.server 8000`
3. Open **http://localhost:8000** in your browser

**⚠️ Limitation:** Loop changes won't be saved to the JSON file

## Quick Command Reference

### Start Enhanced Server (Recommended)
```bash
cd sound-tap
python3 server.py
```
**Features**: Full functionality + JSON persistence

### Start Basic Server (Read-only)  
```bash
cd sound-tap
python3 -m http.server 8000
```
**Features**: Basic playback only

### Fix Port Conflicts
```bash
# Find what's using port 8000
lsof -ti :8000

# Kill the process (replace XXXX with the process ID)
kill XXXX

# Then start your preferred server
python3 server.py
```

### Switch from Basic to Enhanced Server
1. **Stop current server**: Press `Ctrl+C` in the server terminal
2. **Start enhanced server**: `python3 server.py`
3. **Refresh browser**: Your loop changes will now be saved!

## Troubleshooting

### Server Issues

**Getting "Port 8000 is already in use" error?**
- You have another server running on port 8000
- **Stop the old server first**:
  1. Find the process: `lsof -ti :8000`
  2. Kill it: `kill [process_id]`
  3. Then start the new server: `python3 server.py`

**Getting 501 "Unsupported method" errors when toggling loop?**
- ⚠️ **You're using the basic server instead of the enhanced one**
- The basic `python3 -m http.server` doesn't support POST requests
- **Solution**: Switch to the enhanced server:
  1. Stop current server (Ctrl+C)
  2. Run: `python3 server.py`
  3. Loop changes will now be saved to JSON!

**Enhanced server won't start?**
- Make sure you're in the `sound-tap` directory
- Verify `server.py` file exists
- Check that `sounds.json` and `index.html` are present

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

**Loop changes not saving?**
- ⚠️ **Using basic server**: Loop changes only work with the enhanced server (`python3 server.py`)
- Check for error notifications in the top-right corner of the UI
- Verify the server console shows "✅ Updated sound X: loop = true/false"

---

Enjoy your Sound Tap experience! 🎵
