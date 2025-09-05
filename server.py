#!/usr/bin/env python3
"""
Simple HTTP server for Sound Tap with JSON update capability.
Serves static files and handles updates to sounds.json when loop states change.
"""

import http.server
import socketserver
import json
import urllib.parse
from pathlib import Path
import sys
import os

class SoundTapHandler(http.server.SimpleHTTPRequestHandler):
    """Custom handler that serves static files and handles JSON updates."""
    
    def do_POST(self):
        """Handle POST requests for updating sounds.json"""
        if self.path == '/api/update-sound':
            try:
                # Get content length and read the request body
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                
                # Parse the JSON data
                data = json.loads(post_data.decode('utf-8'))
                sound_index = data.get('index')
                loop_state = data.get('loop')
                
                if sound_index is None or loop_state is None:
                    self.send_error(400, "Missing index or loop parameter")
                    return
                
                # Read current sounds.json
                try:
                    with open('sounds.json', 'r', encoding='utf-8') as f:
                        sounds_data = json.load(f)
                except FileNotFoundError:
                    self.send_error(404, "sounds.json not found")
                    return
                except json.JSONDecodeError:
                    self.send_error(500, "Invalid JSON in sounds.json")
                    return
                
                # Validate index
                if sound_index < 0 or sound_index >= len(sounds_data.get('sounds', [])):
                    self.send_error(400, "Invalid sound index")
                    return
                
                # Update the loop state
                sounds_data['sounds'][sound_index]['loop'] = bool(loop_state)
                
                # Write back to sounds.json
                try:
                    with open('sounds.json', 'w', encoding='utf-8') as f:
                        json.dump(sounds_data, f, indent=4, ensure_ascii=False)
                except Exception as e:
                    self.send_error(500, f"Failed to write sounds.json: {str(e)}")
                    return
                
                # Send success response
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                
                response = {
                    'success': True,
                    'message': f"Updated sound {sound_index} loop state to {loop_state}"
                }
                self.wfile.write(json.dumps(response).encode('utf-8'))
                
                print(f"✅ Updated sound {sound_index}: loop = {loop_state}")
                
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON in request")
            except Exception as e:
                self.send_error(500, f"Server error: {str(e)}")
        else:
            self.send_error(404, "Endpoint not found")
    
    def do_OPTIONS(self):
        """Handle CORS preflight requests"""
        if self.path == '/api/update-sound':
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.end_headers()
        else:
            super().do_OPTIONS()
    
    def end_headers(self):
        """Add CORS headers to all responses"""
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

def main():
    """Start the Sound Tap server"""
    PORT = 8000
    
    # Change to the script's directory
    script_dir = Path(__file__).parent
    os.chdir(script_dir)
    
    # Verify required files exist
    if not Path('sounds.json').exists():
        print("❌ Error: sounds.json not found!")
        print("   Make sure you're running this from the sound-tap directory.")
        sys.exit(1)
    
    if not Path('index.html').exists():
        print("❌ Error: index.html not found!")
        print("   Make sure you're running this from the sound-tap directory.")
        sys.exit(1)
    
    # Start the server
    try:
        with socketserver.TCPServer(("", PORT), SoundTapHandler) as httpd:
            print(f"🎵 Sound Tap Server running at http://localhost:{PORT}/")
            print(f"📁 Serving files from: {Path.cwd()}")
            print(f"🔄 JSON updates enabled - loop changes will be saved!")
            print(f"⏹️  Press Ctrl+C to stop the server")
            print()
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n⏹️  Server stopped by user")
    except OSError as e:
        if e.errno == 48:  # Address already in use
            print(f"❌ Error: Port {PORT} is already in use!")
            print("   Stop any existing server and try again.")
        else:
            print(f"❌ Error starting server: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()
