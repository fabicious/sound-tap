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

1. Navigate to the `sound-tap` directory
2. Start the web server: `python3 -m http.server 8000`  
3. Open **http://localhost:8000** in your browser
4. Add your audio files to the `sounds/` folder
5. Update `sounds.json` with your file details (including volume levels)
6. Use global volume to control overall loudness, individual sliders for balance

## Troubleshooting

**Getting CORS errors or "Failed to load" messages?**
- ⚠️ **Most common issue**: You must use a web server! Don't open `index.html` directly
- Start the local server: `python3 -m http.server 8000`
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

---

Enjoy your Sound Tap experience! 🎵
