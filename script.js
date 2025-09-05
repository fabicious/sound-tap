class SoundTap {
    constructor() {
        this.sounds = [];
        this.audioElements = new Map(); // Map to store audio elements by sound index
        this.playingAudios = new Set(); // Set to track currently playing audios
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
        const item = document.createElement('div');
        item.className = 'sound-item';
        item.innerHTML = `
            <div class="sound-info">
                <h3>${sound.name}</h3>
                <span class="file-path">${sound.file}</span>
            </div>
            <div class="sound-controls">
                <button class="play-exclusive-btn" data-index="${index}">
                    ▶️ Play (Stop Others)
                </button>
                <button class="play-additive-btn" data-index="${index}">
                    ➕ Play (Add)
                </button>
                <button class="pause-btn" data-index="${index}" disabled>
                    ⏸️ Pause
                </button>
                <button class="stop-btn" data-index="${index}" disabled>
                    ⏹️ Stop
                </button>
                <label class="loop-control">
                    <input type="checkbox" class="loop-checkbox" data-index="${index}" ${sound.loop ? 'checked' : ''}>
                    🔄 Loop
                </label>
            </div>
            <div class="sound-status" id="status-${index}">Ready</div>
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

        playExclusiveBtn.addEventListener('click', () => this.playSound(index, true));
        playAdditiveBtn.addEventListener('click', () => this.playSound(index, false));
        pauseBtn.addEventListener('click', () => this.pauseSound(index));
        stopBtn.addEventListener('click', () => this.stopSound(index));
        loopCheckbox.addEventListener('change', (e) => this.toggleLoop(index, e.target.checked));
    }

    setupGlobalControls() {
        const stopAllBtn = document.getElementById('stop-all-btn');
        stopAllBtn.addEventListener('click', () => this.stopAllSounds());
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

        const status = shouldLoop ? 'Loop enabled' : 'Loop disabled';
        this.updateSoundStatus(index, status);

        // Reset status after 2 seconds
        setTimeout(() => {
            const currentAudio = this.audioElements.get(index);
            if (currentAudio && !currentAudio.paused) {
                this.updateSoundStatus(index, 'Playing');
            } else {
                this.updateSoundStatus(index, 'Ready');
            }
        }, 2000);
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

        switch (state) {
            case 'playing':
                playExclusiveBtn.disabled = true;
                playAdditiveBtn.disabled = true;
                pauseBtn.disabled = false;
                stopBtn.disabled = false;
                break;
            case 'paused':
            case 'stopped':
            case 'error':
                playExclusiveBtn.disabled = false;
                playAdditiveBtn.disabled = false;
                pauseBtn.disabled = true;
                stopBtn.disabled = true;
                break;
        }
    }

    updateSoundStatus(index, message) {
        const statusElement = document.getElementById(`status-${index}`);
        if (statusElement) {
            statusElement.textContent = message;
        }
    }

    updateStatus(message) {
        const statusElement = document.getElementById('status-text');
        if (statusElement) {
            statusElement.textContent = message;
        }
    }
}

// Initialize the app when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SoundTap();
});
