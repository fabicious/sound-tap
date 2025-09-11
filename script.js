class SoundTap {
    constructor() {
        this.sounds = [];
        this.audioElements = new Map(); // Map to store audio elements by sound index
        this.playingAudios = new Set(); // Set to track currently playing audios
        this.globalVolume = 0.8; // Default global volume (80%)
        this.availableSoundPacks = []; // List of available JSON files
        this.currentSoundPack = 'dndeekend.json'; // Current selected sound pack
        this.init();
    }

    async init() {
        try {
            await this.discoverSoundPacks();
            this.loadFileSelectionFromStorage();
            await this.loadSounds(this.currentSoundPack);
            this.loadSettingsFromStorage(); // Load saved settings from localStorage
            this.renderSounds();
            this.setupGlobalControls();
            this.updateStatus('Ready! Add your sound files to the sounds/ directory.');
        } catch (error) {
            console.error('Failed to initialize:', error);
            this.updateStatus('Error loading sounds. Please check your sound pack files.');
        }
    }

    async discoverSoundPacks() {
        try {
            // Fetch the index file that lists available packs
            const response = await fetch('packs/index.json');
            if (response.ok) {
                const index = await response.json();
                this.availableSoundPacks = index.packs || [];
            } else {
                // Fallback to known packs if index.json doesn't exist
                this.availableSoundPacks = ['dndeekend.json', 'migo.json'];
            }
        } catch (error) {
            console.warn('Could not load pack index, using fallback:', error);
            this.availableSoundPacks = ['dndeekend.json', 'migo.json'];
        }

        // Ensure we have at least one pack
        if (this.availableSoundPacks.length === 0) {
            this.availableSoundPacks.push('dndeekend.json');
        }

        // Update the dropdown
        this.updateSoundPackSelector();
    }

    updateSoundPackSelector() {
        const select = document.getElementById('sound-pack-select');
        if (!select) return;

        // Clear current options
        select.innerHTML = '';

        // Add available sound packs
        this.availableSoundPacks.forEach(packName => {
            const option = document.createElement('option');
            option.value = packName;
            option.textContent = this.getDisplayName(packName);
            if (packName === this.currentSoundPack) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    }

    getDisplayName(filename) {
        // Convert filename to a more user-friendly display name
        return filename
            .replace('.json', '')
            .replace(/[-_]/g, ' ')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    async loadSounds(soundPackFile = 'dndeekend.json') {
        try {
            const response = await fetch(`packs/${soundPackFile}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            this.sounds = data.sounds || [];
            this.currentSoundPack = soundPackFile;

            // Load global volume setting
            if (data.globalVolume !== undefined) {
                this.globalVolume = data.globalVolume / 100;
            }

            // Update the UI to reflect the new sound pack
            this.updateSoundPackSelector();

        } catch (error) {
            console.error(`Error loading sounds from packs/${soundPackFile}:`, error);
            throw error;
        }
    }

    renderSounds() {
        const soundList = document.getElementById('sound-list');
        soundList.innerHTML = '';

        this.sounds.forEach((sound, index) => {
            if (sound.sounds && Array.isArray(sound.sounds)) {
                // This is a group
                const groupElement = this.createSoundGroup(sound, index);
                soundList.appendChild(groupElement);
            } else {
                // This is a regular sound
                const soundItem = this.createSoundItem(sound, index);
                soundList.appendChild(soundItem);
            }
        });
    }

    createSoundGroup(group, groupIndex) {
        const groupElement = document.createElement('div');
        groupElement.className = 'sound-group';

        // Create group header
        const groupHeader = document.createElement('div');
        groupHeader.className = 'group-header';
        groupHeader.innerHTML = `<h3 class="group-name">${group.name}</h3>`;
        groupElement.appendChild(groupHeader);

        // Create container for group sounds
        const groupSounds = document.createElement('div');
        groupSounds.className = 'group-sounds';

        // Add each sound in the group
        group.sounds.forEach((sound, soundIndex) => {
            const globalIndex = this.getGlobalSoundIndex(groupIndex, soundIndex);
            const soundItem = this.createSoundItem(sound, globalIndex);
            soundItem.classList.add('grouped-sound');
            groupSounds.appendChild(soundItem);
        });

        groupElement.appendChild(groupSounds);
        return groupElement;
    }

    getGlobalSoundIndex(groupIndex, soundIndex) {
        // Calculate the global index for a sound within a group
        let globalIndex = 0;

        for (let i = 0; i < groupIndex; i++) {
            if (this.sounds[i].sounds && Array.isArray(this.sounds[i].sounds)) {
                globalIndex += this.sounds[i].sounds.length;
            } else {
                globalIndex += 1;
            }
        }

        return globalIndex + soundIndex;
    }

    // Get a flattened array of all sounds for indexing purposes
    getFlatSounds() {
        const flatSounds = [];
        this.sounds.forEach(sound => {
            if (sound.sounds && Array.isArray(sound.sounds)) {
                // Add all sounds from the group
                flatSounds.push(...sound.sounds);
            } else {
                // Add the single sound
                flatSounds.push(sound);
            }
        });
        return flatSounds;
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
        const resetBtn = document.getElementById('reset-settings-btn');
        const exportBtn = document.getElementById('export-settings-btn');
        const soundPackSelect = document.getElementById('sound-pack-select');

        // Set initial global volume slider value from loaded data
        globalVolumeSlider.value = Math.round(this.globalVolume * 100);

        stopAllBtn.addEventListener('click', () => this.stopAllSounds());
        globalVolumeSlider.addEventListener('input', (e) => this.setGlobalVolume(e.target.value));
        resetBtn.addEventListener('click', () => this.resetAllSettings());
        exportBtn.addEventListener('click', () => this.exportSettings());

        // Sound pack selection
        soundPackSelect.addEventListener('change', (e) => this.switchSoundPack(e.target.value));
    }

    async playSound(index, exclusive = false) {
        try {
            if (exclusive) {
                this.stopAllSounds();
            }

            let audio = this.audioElements.get(index);
            const flatSounds = this.getFlatSounds();
            const sound = flatSounds[index];

            if (!sound) {
                console.error(`Sound at index ${index} not found`);
                return;
            }

            if (!audio) {
                // Create new audio element
                audio = new Audio(sound.file);
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

        // Save the change to localStorage
        this.saveSettingsToStorage();
    }

    saveSettingsToStorage() {
        try {
            // Save pack-specific settings (preserving group structure)
            const packSettings = {
                globalVolume: Math.round(this.globalVolume * 100),
                sounds: this.sounds.map(sound => {
                    if (sound.sounds && Array.isArray(sound.sounds)) {
                        // This is a group
                        return {
                            name: sound.name,
                            sounds: sound.sounds.map(groupSound => ({
                                name: groupSound.name,
                                file: groupSound.file,
                                loop: groupSound.loop,
                                volume: groupSound.volume
                            }))
                        };
                    } else {
                        // This is a regular sound
                        return {
                            name: sound.name,
                            file: sound.file,
                            loop: sound.loop,
                            volume: sound.volume
                        };
                    }
                })
            };

            // Save general app settings
            const appSettings = {
                currentSoundPack: this.currentSoundPack
            };

            localStorage.setItem(`soundTapPack_${this.currentSoundPack}`, JSON.stringify(packSettings));
            localStorage.setItem('soundTapApp', JSON.stringify(appSettings));
            console.log(`✅ Settings saved for pack: ${this.currentSoundPack}`);
        } catch (error) {
            console.error('❌ Failed to save settings to localStorage:', error);
        }
    }

    loadFileSelectionFromStorage() {
        try {
            // First try to migrate old format settings
            this.migrateOldLocalStorage();

            const savedAppSettings = localStorage.getItem('soundTapApp');
            if (savedAppSettings) {
                const settings = JSON.parse(savedAppSettings);
                if (settings.currentSoundPack && this.availableSoundPacks.includes(settings.currentSoundPack)) {
                    this.currentSoundPack = settings.currentSoundPack;
                }
            }
        } catch (error) {
            console.error('❌ Failed to load file selection from localStorage:', error);
        }
    }

    migrateOldLocalStorage() {
        try {
            const oldSettings = localStorage.getItem('soundTapSettings');
            if (oldSettings) {
                const settings = JSON.parse(oldSettings);

                // Migrate to new format
                if (settings.currentSoundPack) {
                    // Save app settings
                    const appSettings = {
                        currentSoundPack: settings.currentSoundPack
                    };
                    localStorage.setItem('soundTapApp', JSON.stringify(appSettings));

                    // Save pack-specific settings
                    const packSettings = {
                        globalVolume: settings.globalVolume,
                        sounds: settings.sounds
                    };
                    localStorage.setItem(`soundTapPack_${settings.currentSoundPack}`, JSON.stringify(packSettings));
                } else {
                    // Old format without currentSoundPack, assume sounds.json
                    const packSettings = {
                        globalVolume: settings.globalVolume,
                        sounds: settings.sounds
                    };
                    localStorage.setItem('soundTapPack_dndeekend.json', JSON.stringify(packSettings));
                }

                // Remove old settings
                localStorage.removeItem('soundTapSettings');
                console.log('✅ Migrated old localStorage format');
            }
        } catch (error) {
            console.error('❌ Failed to migrate old localStorage:', error);
        }
    }

    loadSettingsFromStorage() {
        try {
            const packKey = `soundTapPack_${this.currentSoundPack}`;
            const savedPackSettings = localStorage.getItem(packKey);

            if (savedPackSettings) {
                const settings = JSON.parse(savedPackSettings);

                // Load global volume
                if (settings.globalVolume !== undefined) {
                    this.globalVolume = settings.globalVolume / 100;
                }

                // Load individual sound settings (loop and volume), handling groups
                if (settings.sounds && Array.isArray(settings.sounds)) {
                    settings.sounds.forEach((savedSound, index) => {
                        if (this.sounds[index]) {
                            if (savedSound.sounds && Array.isArray(savedSound.sounds)) {
                                // This is a group
                                if (this.sounds[index].sounds && Array.isArray(this.sounds[index].sounds)) {
                                    savedSound.sounds.forEach((savedGroupSound, groupIndex) => {
                                        if (this.sounds[index].sounds[groupIndex]) {
                                            if (savedGroupSound.loop !== undefined) {
                                                this.sounds[index].sounds[groupIndex].loop = savedGroupSound.loop;
                                            }
                                            if (savedGroupSound.volume !== undefined) {
                                                this.sounds[index].sounds[groupIndex].volume = savedGroupSound.volume;
                                            }
                                        }
                                    });
                                }
                            } else {
                                // This is a regular sound
                                if (savedSound.loop !== undefined) {
                                    this.sounds[index].loop = savedSound.loop;
                                }
                                if (savedSound.volume !== undefined) {
                                    this.sounds[index].volume = savedSound.volume;
                                }
                            }
                        }
                    });
                }

                console.log(`✅ Settings loaded for pack: ${this.currentSoundPack}`);
                return true;
            }
        } catch (error) {
            console.error(`❌ Failed to load settings for pack ${this.currentSoundPack}:`, error);
        }
        return false;
    }

    resetAllSettings() {
        // Show confirmation dialog
        const confirmed = confirm(
            'Reset all settings to defaults?\n\n' +
            'This will:\n' +
            '• Clear all volume adjustments\n' +
            '• Reset all loop settings\n' +
            `• Return to values from ${this.currentSoundPack}\n\n` +
            'This action cannot be undone.'
        );

        if (confirmed) {
            try {
                // Clear pack-specific localStorage
                const packKey = `soundTapPack_${this.currentSoundPack}`;
                localStorage.removeItem(packKey);
                console.log(`✅ localStorage cleared for pack: ${this.currentSoundPack}`);

                // Show success notification
                this.showNotification('Settings reset! Reloading page...', 'info');

                // Reload the page after a short delay to show the notification
                setTimeout(() => {
                    window.location.reload();
                }, 1000);

            } catch (error) {
                console.error('❌ Failed to reset settings:', error);
                this.showNotification('Failed to reset settings: ' + error.message, 'error');
            }
        }
    }

    exportSettings() {
        try {
            // Create the export data structure (same as sounds.json format)
            const exportData = {
                globalVolume: Math.round(this.globalVolume * 100),
                sounds: this.sounds.map(sound => ({
                    name: sound.name,
                    file: sound.file,
                    loop: sound.loop,
                    volume: sound.volume
                }))
            };

            // Create formatted JSON string
            const jsonString = JSON.stringify(exportData, null, 4);

            // Create blob and download link
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            // Create temporary download link
            const downloadLink = document.createElement('a');
            downloadLink.href = url;

            // Generate filename with timestamp and pack name
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
            const packName = this.currentSoundPack.replace('.json', '');
            downloadLink.download = `sound-tap-${packName}-settings-${timestamp}.json`;

            // Trigger download
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);

            // Clean up the blob URL
            URL.revokeObjectURL(url);

            console.log('✅ Settings exported successfully');
            this.showNotification('Settings exported! Check your downloads folder.', 'info');

        } catch (error) {
            console.error('❌ Failed to export settings:', error);
            this.showNotification('Failed to export settings: ' + error.message, 'error');
        }
    }

    showNotification(message, type = 'info') {
        // Create a simple notification system
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            background: ${type === 'error' ? '#e74c3c' : '#2ecc71'};
            color: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            z-index: 1000;
            font-size: 14px;
            max-width: 300px;
            word-wrap: break-word;
        `;

        document.body.appendChild(notification);

        // Auto-remove after 3 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 3000);
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
        // Status bar removed - no longer needed
    }

    setGlobalVolume(value) {
        this.globalVolume = value / 100;

        // Update all audio elements with new global volume
        this.audioElements.forEach((audio, index) => {
            this.updateAudioVolume(index);
        });

        // Save the global volume change to localStorage
        this.saveSettingsToStorage();

        this.updateStatus(`Global volume set to ${value}%`);
    }

    setIndividualVolume(index, value) {
        const newVolume = parseInt(value);
        const flatSounds = this.getFlatSounds();

        if (flatSounds[index]) {
            // Update the sound object in the flattened array
            flatSounds[index].volume = newVolume;

            // Also update the original nested structure
            this.updateOriginalSoundVolume(index, newVolume);

            // Update the audio element if it exists
            this.updateAudioVolume(index);

            // Save the volume change to localStorage
            this.saveSettingsToStorage();
        }
    }

    updateOriginalSoundVolume(flatIndex, newVolume) {
        let currentIndex = 0;

        for (let i = 0; i < this.sounds.length; i++) {
            if (this.sounds[i].sounds && Array.isArray(this.sounds[i].sounds)) {
                // This is a group
                for (let j = 0; j < this.sounds[i].sounds.length; j++) {
                    if (currentIndex === flatIndex) {
                        this.sounds[i].sounds[j].volume = newVolume;
                        return;
                    }
                    currentIndex++;
                }
            } else {
                // This is a single sound
                if (currentIndex === flatIndex) {
                    this.sounds[i].volume = newVolume;
                    return;
                }
                currentIndex++;
            }
        }
    }

    updateAudioVolume(index) {
        const audio = this.audioElements.get(index);
        if (audio) {
            const flatSounds = this.getFlatSounds();
            const sound = flatSounds[index];
            if (sound) {
                const individualVolume = (sound.volume || 80) / 100;
                const finalVolume = this.globalVolume * individualVolume;
                audio.volume = Math.max(0, Math.min(1, finalVolume)); // Clamp between 0 and 1
            }
        }
    }

    async switchSoundPack(newSoundPack) {
        if (newSoundPack === this.currentSoundPack) return;

        try {
            // Stop all currently playing sounds
            this.stopAllSounds();

            // Clear audio elements
            this.audioElements.clear();
            this.playingAudios.clear();

            // Load the new sound pack (this sets this.currentSoundPack)
            await this.loadSounds(newSoundPack);

            // Load saved settings for this specific pack
            this.loadSettingsFromStorage();

            // Re-render the sound list with loaded settings
            this.renderSounds();

            // Update global volume slider with loaded settings
            const globalVolumeSlider = document.getElementById('global-volume-slider');
            globalVolumeSlider.value = Math.round(this.globalVolume * 100);

            // Save the current selection (but don't override pack-specific settings)
            const appSettings = {
                currentSoundPack: this.currentSoundPack
            };
            localStorage.setItem('soundTapApp', JSON.stringify(appSettings));

            this.updateStatus(`Switched to sound pack: ${this.getDisplayName(newSoundPack)}`);

        } catch (error) {
            console.error(`Failed to switch to sound pack ${newSoundPack}:`, error);
            this.updateStatus(`Error loading sound pack: ${this.getDisplayName(newSoundPack)}`);
        }
    }

}

// Initialize the app when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SoundTap();
});
