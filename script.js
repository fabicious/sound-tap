class SoundTap {
    constructor() {
        this.sounds = [];
        this.audioElements = new Map(); // Map to store audio elements by sound index
        this.playingAudios = new Set(); // Set to track currently playing audios
        this.globalVolume = 0.8; // Default global volume (80%)
        this.init();
    }

    async init() {
        try {
            await this.loadSounds();
            this.renderSounds();
            this.setupGlobalControls();
            this.updateStatus('Ready! Add your sound files to the sounds/ directory.');
        } catch (error) {
            console.error('Failed to initialize:', error);
            this.updateStatus('Error loading sounds. Please check sounds.json file.');
        }
    }

    async loadSounds() {
        try {
            const response = await fetch('sounds.json');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            this.sounds = data.sounds || [];
        } catch (error) {
            console.error('Error loading sounds:', error);
            throw error;
        }
    }

    renderSounds() {
        const soundList = document.getElementById('sound-list');
        soundList.innerHTML = '';

        this.sounds.forEach((sound, index) => {
            const soundItem = this.createSoundItem(sound, index);
            soundList.appendChild(soundItem);
        });
    }

    createSoundItem(sound, index) {
        const defaultVolume = sound.volume || 80;
        const item = document.createElement('div');
        item.className = 'sound-tile';
        item.innerHTML = `
            <div class="tile-header">
                <h3 class="sound-name">${sound.name}</h3>
                <label class="loop-control" title="Loop">
                    <input type="checkbox" class="loop-checkbox" data-index="${index}" ${sound.loop ? 'checked' : ''}>
                    <span class="loop-icon">🔄</span>
                </label>
            </div>
            
            <div class="tile-controls">
                <div class="playback-controls">
                    <button class="control-btn play-exclusive-btn" data-index="${index}" title="Play (Stop Others)">
                        ▶️
                    </button>
                    <button class="control-btn play-additive-btn" data-index="${index}" title="Play (Add)">
                        ➕
                    </button>
                    <button class="control-btn pause-btn" data-index="${index}" disabled title="Pause">
                        ⏸️
                    </button>
                    <button class="control-btn stop-btn" data-index="${index}" disabled title="Stop">
                        ⏹️
                    </button>
                </div>
            </div>
            
            <div class="volume-control">
                <div class="volume-slider-container">
                    🔊 <input type="range" class="volume-slider individual-volume" data-index="${index}" min="0" max="100" value="${defaultVolume}">
                </div>
            </div>
        `;

        this.setupSoundControls(item, index);
        return item;
    }

    setupSoundControls(item, index) {
        const playExclusiveBtn = item.querySelector('.play-exclusive-btn');
        const playAdditiveBtn = item.querySelector('.play-additive-btn');
        const pauseBtn = item.querySelector('.pause-btn');
        const stopBtn = item.querySelector('.stop-btn');
        const loopCheckbox = item.querySelector('.loop-checkbox');
        const volumeSlider = item.querySelector('.individual-volume');

        playExclusiveBtn.addEventListener('click', () => this.playSound(index, true));
        playAdditiveBtn.addEventListener('click', () => this.playSound(index, false));
        pauseBtn.addEventListener('click', () => this.pauseSound(index));
        stopBtn.addEventListener('click', () => this.stopSound(index));
        loopCheckbox.addEventListener('change', (e) => this.toggleLoop(index, e.target.checked));
        volumeSlider.addEventListener('input', (e) => this.setIndividualVolume(index, e.target.value));
    }

    setupGlobalControls() {
        const stopAllBtn = document.getElementById('stop-all-btn');
        const globalVolumeSlider = document.getElementById('global-volume-slider');

        stopAllBtn.addEventListener('click', () => this.stopAllSounds());
        globalVolumeSlider.addEventListener('input', (e) => this.setGlobalVolume(e.target.value));
    }

    async playSound(index, exclusive = false) {
        try {
            if (exclusive) {
                this.stopAllSounds();
            }

            let audio = this.audioElements.get(index);

            if (!audio) {
                // Create new audio element
                audio = new Audio(this.sounds[index].file);
                audio.addEventListener('ended', () => this.onSoundEnded(index));
                audio.addEventListener('error', (e) => this.onSoundError(index, e));
                audio.addEventListener('loadstart', () => this.updateSoundStatus(index, 'Loading...'));
                audio.addEventListener('canplay', () => this.updateSoundStatus(index, 'Ready'));
                this.audioElements.set(index, audio);
            }

            // Set loop based on current checkbox state
            const loopCheckbox = document.querySelector(`[data-index="${index}"].loop-checkbox`);
            audio.loop = loopCheckbox.checked;

            // Set volume based on individual and global settings
            this.updateAudioVolume(index);

            // Reset to beginning if already ended
            if (audio.ended) {
                audio.currentTime = 0;
            }

            await audio.play();
            this.playingAudios.add(index);
            this.updateSoundControls(index, 'playing');
            this.updateSoundStatus(index, 'Playing');

        } catch (error) {
            console.error(`Error playing sound ${index}:`, error);
            this.updateSoundStatus(index, `Error: ${error.message}`);
        }
    }

    pauseSound(index) {
        const audio = this.audioElements.get(index);
        if (audio && !audio.paused) {
            audio.pause();
            this.playingAudios.delete(index);
            this.updateSoundControls(index, 'paused');
            this.updateSoundStatus(index, 'Paused');
        }
    }

    stopSound(index) {
        const audio = this.audioElements.get(index);
        if (audio) {
            audio.pause();
            audio.currentTime = 0;
            this.playingAudios.delete(index);
            this.updateSoundControls(index, 'stopped');
            this.updateSoundStatus(index, 'Ready');
        }
    }

    stopAllSounds() {
        this.audioElements.forEach((audio, index) => {
            if (!audio.paused) {
                this.stopSound(index);
            }
        });
        this.updateStatus(`Stopped all sounds (${this.playingAudios.size} were playing)`);
    }

    toggleLoop(index, shouldLoop) {
        const audio = this.audioElements.get(index);
        if (audio) {
            audio.loop = shouldLoop;
        }

        // Update the sound definition for consistency
        this.sounds[index].loop = shouldLoop;
    }

    onSoundEnded(index) {
        this.playingAudios.delete(index);
        this.updateSoundControls(index, 'stopped');
        this.updateSoundStatus(index, 'Ready');
    }

    onSoundError(index, error) {
        console.error(`Sound ${index} error:`, error);
        this.playingAudios.delete(index);
        this.updateSoundControls(index, 'error');
        this.updateSoundStatus(index, 'File not found');
    }

    updateSoundControls(index, state) {
        const playExclusiveBtn = document.querySelector(`[data-index="${index}"].play-exclusive-btn`);
        const playAdditiveBtn = document.querySelector(`[data-index="${index}"].play-additive-btn`);
        const pauseBtn = document.querySelector(`[data-index="${index}"].pause-btn`);
        const stopBtn = document.querySelector(`[data-index="${index}"].stop-btn`);

        // Find the tile element to add/remove playing class
        const tileElement = playExclusiveBtn.closest('.sound-tile');

        switch (state) {
            case 'playing':
                playExclusiveBtn.disabled = true;
                playAdditiveBtn.disabled = true;
                pauseBtn.disabled = false;
                stopBtn.disabled = false;
                if (tileElement) tileElement.classList.add('playing');
                break;
            case 'paused':
            case 'stopped':
            case 'error':
                playExclusiveBtn.disabled = false;
                playAdditiveBtn.disabled = false;
                pauseBtn.disabled = true;
                stopBtn.disabled = true;
                if (tileElement) tileElement.classList.remove('playing');
                break;
        }
    }

    updateSoundStatus(index, status) {
        const tileElement = document.querySelector(`[data-index="${index}"]`).closest('.sound-tile');
        if (!tileElement) return;

        // Remove all status classes
        tileElement.classList.remove('tile-loading', 'tile-error', 'tile-paused');

        // Add specific status class based on status
        if (status === 'Loading...') {
            tileElement.classList.add('tile-loading');
        } else if (status === 'File not found' || status.startsWith('Error:')) {
            tileElement.classList.add('tile-error');
        } else if (status === 'Paused') {
            tileElement.classList.add('tile-paused');
        }
        // 'Ready', 'Playing', 'Loop enabled', 'Loop disabled' don't need special background colors
    }

    updateStatus(message) {
        const statusElement = document.getElementById('status-text');
        if (statusElement) {
            statusElement.textContent = message;
        }
    }

    setGlobalVolume(value) {
        this.globalVolume = value / 100;

        // Update all audio elements with new global volume
        this.audioElements.forEach((audio, index) => {
            this.updateAudioVolume(index);
        });

        this.updateStatus(`Global volume set to ${value}%`);
    }

    setIndividualVolume(index, value) {
        // Update the sound object
        this.sounds[index].volume = parseInt(value);

        // Update the audio element if it exists
        this.updateAudioVolume(index);
    }

    updateAudioVolume(index) {
        const audio = this.audioElements.get(index);
        if (audio) {
            const individualVolume = (this.sounds[index].volume || 80) / 100;
            const finalVolume = this.globalVolume * individualVolume;
            audio.volume = Math.max(0, Math.min(1, finalVolume)); // Clamp between 0 and 1
        }
    }
}

// Initialize the app when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SoundTap();
});
