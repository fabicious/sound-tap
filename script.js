// ─── SoundStore: IndexedDB storage layer for audio blobs and pack metadata ───

class SoundStore {
    constructor() {
        this.db = null;
        this.blobUrlCache = new Map(); // audioId -> blobUrl
    }

    open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('SoundTapDB', 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('packs')) {
                    db.createObjectStore('packs', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('audio')) {
                    db.createObjectStore('audio', { keyPath: 'id' });
                }
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                this.requestPersistence();
                resolve();
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async requestPersistence() {
        if (navigator.storage && navigator.storage.persist) {
            const granted = await navigator.storage.persist();
            console.log(granted ? 'Storage persisted' : 'Storage not persisted');
        }
    }

    _tx(storeName, mode = 'readonly') {
        const tx = this.db.transaction(storeName, mode);
        return tx.objectStore(storeName);
    }

    _request(store, method, ...args) {
        return new Promise((resolve, reject) => {
            const req = store[method](...args);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async getAllPacks() {
        const store = this._tx('packs');
        const packs = await this._request(store, 'getAll');
        return packs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }

    async getPack(packId) {
        const store = this._tx('packs');
        return this._request(store, 'get', packId);
    }

    async savePack(pack) {
        pack.updatedAt = Date.now();
        const store = this._tx('packs', 'readwrite');
        return this._request(store, 'put', pack);
    }

    async deletePack(packId) {
        // Get pack first to find audio IDs to clean up
        const pack = await this.getPack(packId);
        if (pack) {
            const audioIds = this._collectAudioIds(pack.sounds || []);
            // Check if any audio is used by other packs
            const allPacks = await this.getAllPacks();
            const otherAudioIds = new Set();
            allPacks.forEach(p => {
                if (p.id !== packId) {
                    this._collectAudioIds(p.sounds || []).forEach(id => otherAudioIds.add(id));
                }
            });
            // Delete orphaned audio
            const audioStore = this._tx('audio', 'readwrite');
            for (const audioId of audioIds) {
                if (!otherAudioIds.has(audioId)) {
                    audioStore.delete(audioId);
                }
            }
        }
        const store = this._tx('packs', 'readwrite');
        return this._request(store, 'delete', packId);
    }

    _collectAudioIds(sounds) {
        const ids = [];
        for (const s of sounds) {
            if (s.sounds && Array.isArray(s.sounds)) {
                ids.push(...this._collectAudioIds(s.sounds));
            } else if (s.audioId) {
                ids.push(s.audioId);
            }
        }
        return ids;
    }

    async saveAudio(file) {
        const id = crypto.randomUUID();
        const blob = file instanceof Blob ? file : new Blob([file]);
        const record = {
            id,
            name: file.name || 'unknown',
            mimeType: file.type || 'audio/mpeg',
            blob,
            size: blob.size,
            createdAt: Date.now()
        };
        const store = this._tx('audio', 'readwrite');
        await this._request(store, 'put', record);
        return id;
    }

    async getAudioBlob(audioId) {
        if (!audioId) return null;
        const store = this._tx('audio');
        const record = await this._request(store, 'get', audioId);
        return record ? record.blob : null;
    }

    async getAudioUrl(audioId) {
        if (!audioId) return null;
        if (this.blobUrlCache.has(audioId)) {
            return this.blobUrlCache.get(audioId);
        }
        const blob = await this.getAudioBlob(audioId);
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        this.blobUrlCache.set(audioId, url);
        return url;
    }

    async deleteAudio(audioId) {
        if (!audioId) return;
        if (this.blobUrlCache.has(audioId)) {
            URL.revokeObjectURL(this.blobUrlCache.get(audioId));
            this.blobUrlCache.delete(audioId);
        }
        const store = this._tx('audio', 'readwrite');
        return this._request(store, 'delete', audioId);
    }

    revokeUrls() {
        this.blobUrlCache.forEach(url => URL.revokeObjectURL(url));
        this.blobUrlCache.clear();
    }
}

// ─── SoundTap: main application ─────────────────────────────────────────────

class SoundTap {
    constructor() {
        this.store = new SoundStore();
        this.sounds = [];
        this.currentPackId = null;
        this.currentPack = null;
        this.audioElements = new Map();
        this.playingAudios = new Set();
        this.globalVolume = 0.8;
        this.searchQuery = '';
        this.sessionTracks = new Set();
        this._flatSoundsCache = null;
        this._saveTimeout = null;
        this._notificationCount = 0;
        this.init();
    }

    // ─── Initialization ──────────────────────────────────────────────────

    async init() {
        try {
            await this.store.open();
            await this.migrateFromServer();
            await this.loadPackList();

            // Restore last selected pack
            const savedApp = localStorage.getItem('soundTapApp');
            if (savedApp) {
                const { currentPackId } = JSON.parse(savedApp);
                if (currentPackId) this.currentPackId = currentPackId;
            }

            // Fall back to first pack
            const packs = await this.store.getAllPacks();
            if (!this.currentPackId && packs.length > 0) {
                this.currentPackId = packs[0].id;
            }

            if (this.currentPackId) {
                await this.loadPack(this.currentPackId);
            }

            this.renderSounds();
            this.setupGlobalControls();
            this.setupKeyboardShortcuts();
            await this.checkAudioFiles();
            this.updateEmptyState();
        } catch (error) {
            console.error('Failed to initialize:', error);
            this.showNotification('Error initializing app: ' + error.message, 'error');
        }
    }

    async migrateFromServer() {
        const packs = await this.store.getAllPacks();
        if (packs.length > 0) return; // Already have data

        try {
            const cacheBuster = Date.now();
            const response = await fetch(`packs/index.json?v=${cacheBuster}`);
            if (!response.ok) return;
            const index = await response.json();
            const packFiles = index.packs || [];

            for (let i = 0; i < packFiles.length; i++) {
                const packFile = packFiles[i];
                this.showNotification(`Importing pack ${i + 1}/${packFiles.length}...`, 'info');
                try {
                    const packResp = await fetch(`packs/${packFile}?v=${cacheBuster}`);
                    if (!packResp.ok) continue;
                    const data = await packResp.json();

                    const packId = packFile.replace('.json', '');
                    const packName = packId.replace(/[-_]/g, ' ').split(' ')
                        .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

                    const sounds = await this._migrateSound(data.sounds || []);
                    await this.store.savePack({
                        id: packId,
                        name: packName,
                        globalVolume: data.globalVolume || 80,
                        sounds,
                        createdAt: Date.now()
                    });
                } catch (err) {
                    console.warn(`Failed to import pack ${packFile}:`, err);
                }
            }

            // Migrate localStorage settings
            this._migrateLocalStorageSettings();

        } catch (error) {
            console.log('No server packs to migrate (running standalone)');
        }
    }

    async _migrateSound(sounds) {
        const result = [];
        for (const entry of sounds) {
            if (entry.sounds && Array.isArray(entry.sounds)) {
                const groupSounds = await this._migrateSound(entry.sounds);
                result.push({ name: entry.name, sounds: groupSounds });
            } else {
                let audioId = null;
                if (entry.file) {
                    try {
                        const resp = await fetch(entry.file);
                        if (resp.ok) {
                            const blob = await resp.blob();
                            const file = new File([blob], entry.file.split('/').pop(), { type: blob.type });
                            audioId = await this.store.saveAudio(file);
                        }
                    } catch (e) {
                        console.warn(`Could not fetch audio: ${entry.file}`);
                    }
                }
                result.push({
                    name: entry.name,
                    audioId,
                    volume: entry.volume || 80,
                    loop: entry.loop || false
                });
            }
        }
        return result;
    }

    _migrateLocalStorageSettings() {
        try {
            // Apply any saved localStorage settings to the migrated IndexedDB packs
            const keys = Object.keys(localStorage);
            for (const key of keys) {
                if (key.startsWith('soundTapPack_')) {
                    const packFile = key.replace('soundTapPack_', '');
                    const packId = packFile.replace('.json', '');
                    const settings = JSON.parse(localStorage.getItem(key));
                    // We'll apply these asynchronously
                    this._applyMigratedSettings(packId, settings);
                }
            }
        } catch (e) {
            console.warn('Failed to migrate localStorage settings:', e);
        }
    }

    async _applyMigratedSettings(packId, settings) {
        const pack = await this.store.getPack(packId);
        if (!pack || !settings) return;

        if (settings.globalVolume !== undefined) {
            pack.globalVolume = settings.globalVolume;
        }

        if (settings.sounds && Array.isArray(settings.sounds)) {
            // Build lookup by file path
            const savedByFile = new Map();
            const collectSaved = (sounds) => {
                for (const s of sounds) {
                    if (s.sounds) collectSaved(s.sounds);
                    else if (s.file) savedByFile.set(s.file, s);
                }
            };
            collectSaved(settings.sounds);

            // We can't match by file anymore since we replaced files with audioIds
            // The migration already set volume/loop from the JSON, so this is a best-effort
            // match by position for any user overrides
            const applyByPosition = (packSounds, savedSounds) => {
                if (!savedSounds) return;
                for (let i = 0; i < packSounds.length && i < savedSounds.length; i++) {
                    if (packSounds[i].sounds && savedSounds[i].sounds) {
                        applyByPosition(packSounds[i].sounds, savedSounds[i].sounds);
                    } else if (!packSounds[i].sounds && !savedSounds[i].sounds) {
                        if (savedSounds[i].volume !== undefined) packSounds[i].volume = savedSounds[i].volume;
                        if (savedSounds[i].loop !== undefined) packSounds[i].loop = savedSounds[i].loop;
                    }
                }
            };
            applyByPosition(pack.sounds, settings.sounds);
        }

        await this.store.savePack(pack);
    }

    // ─── Pack Loading ────────────────────────────────────────────────────

    async loadPackList() {
        const packs = await this.store.getAllPacks();
        const select = document.getElementById('sound-pack-select');
        if (!select) return;
        select.innerHTML = '';
        packs.forEach(pack => {
            const option = document.createElement('option');
            option.value = pack.id;
            option.textContent = pack.name;
            if (pack.id === this.currentPackId) option.selected = true;
            select.appendChild(option);
        });
    }

    async loadPack(packId) {
        const pack = await this.store.getPack(packId);
        if (!pack) return;

        this.store.revokeUrls();
        this.currentPack = pack;
        this.currentPackId = pack.id;
        this.sounds = pack.sounds || [];
        this.globalVolume = (pack.globalVolume || 80) / 100;
        this.invalidateFlatSoundsCache();
        this.loadSessionFromStorage();

        localStorage.setItem('soundTapApp', JSON.stringify({ currentPackId: this.currentPackId }));

        const globalVolumeSlider = document.getElementById('global-volume-slider');
        if (globalVolumeSlider) globalVolumeSlider.value = Math.round(this.globalVolume * 100);
    }

    async savePack() {
        if (!this.currentPack) return;
        this.currentPack.sounds = this.sounds;
        this.currentPack.globalVolume = Math.round(this.globalVolume * 100);
        await this.store.savePack(this.currentPack);
    }

    savePackDebounced() {
        clearTimeout(this._saveTimeout);
        this._saveTimeout = setTimeout(() => this.savePack(), 300);
    }

    // ─── Audio File Checking ─────────────────────────────────────────────

    async checkAudioFiles() {
        const flatSounds = this.getFlatSounds();
        let missingCount = 0;

        await new Promise(resolve => setTimeout(resolve, 100));

        for (let i = 0; i < flatSounds.length; i++) {
            const sound = flatSounds[i];
            if (!sound || !sound.audioId) {
                if (sound) missingCount++;
                this._markTileError(i, 'No audio file');
                continue;
            }
            const blob = await this.store.getAudioBlob(sound.audioId);
            if (!blob) {
                missingCount++;
                this._markTileError(i, 'Audio missing from storage');
            }
        }

        if (missingCount > 0) {
            console.warn(`Found ${missingCount} missing audio files`);
        }
    }

    _markTileError(index, message) {
        const tiles = document.querySelectorAll(`[data-index="${index}"]`);
        tiles.forEach(el => {
            const tile = el.closest('.sound-tile');
            if (tile) {
                tile.classList.add('tile-error');
                tile.title = message;
            }
        });
    }

    // ─── Rendering ───────────────────────────────────────────────────────

    renderSounds() {
        const soundList = document.getElementById('sound-list');
        soundList.innerHTML = '';

        // Session section
        if (this.sessionTracks.size > 0) {
            const flatSounds = this.getFlatSounds();
            const sessionGroup = document.createElement('div');
            sessionGroup.className = 'sound-group session-group';

            const sessionHeader = document.createElement('div');
            sessionHeader.className = 'group-header session-header';
            sessionHeader.innerHTML = `
                <div class="group-header-content">
                    <h3 class="group-name">Session</h3>
                    <button class="clear-session-btn" title="Clear session selection">Clear</button>
                </div>
            `;
            sessionHeader.style.cursor = 'default';
            sessionGroup.appendChild(sessionHeader);

            const sessionSounds = document.createElement('div');
            sessionSounds.className = 'group-sounds';
            sessionSounds.style.display = 'grid';

            [...this.sessionTracks].sort((a, b) => a - b).forEach(idx => {
                const sound = flatSounds[idx];
                if (sound) {
                    const item = this.createSoundItem(sound, idx);
                    item.classList.add('session-sound');
                    sessionSounds.appendChild(item);
                }
            });

            sessionGroup.appendChild(sessionSounds);
            soundList.appendChild(sessionGroup);
            sessionHeader.querySelector('.clear-session-btn').addEventListener('click', () => this.clearSession());
        }

        // Regular sounds and groups
        this.sounds.forEach((sound, index) => {
            if (sound.sounds && Array.isArray(sound.sounds)) {
                soundList.appendChild(this.createSoundGroup(sound, index));
            } else {
                soundList.appendChild(this.createSoundItem(sound, index));
            }
        });

        // Add group button and add sound button at bottom
        if (this.currentPack) {
            const addBar = document.createElement('div');
            addBar.className = 'add-bar';

            const addGroupBtn = document.createElement('button');
            addGroupBtn.className = 'add-btn';
            addGroupBtn.textContent = '+ Add Group';
            addGroupBtn.addEventListener('click', () => this.addGroup());

            const addSoundBtn = document.createElement('button');
            addSoundBtn.className = 'add-btn';
            addSoundBtn.textContent = '+ Add Sounds';
            addSoundBtn.addEventListener('click', () => this.addSoundsToTop());

            addBar.appendChild(addGroupBtn);
            addBar.appendChild(addSoundBtn);
            soundList.appendChild(addBar);
        }

        this.updateEmptyState();
    }

    createSoundGroup(group, groupIndex) {
        const groupElement = document.createElement('div');
        groupElement.className = 'sound-group';

        const groupHeader = document.createElement('div');
        groupHeader.className = 'group-header';
        const headerContent = document.createElement('div');
        headerContent.className = 'group-header-content';

        const chevron = document.createElement('span');
        chevron.className = 'group-chevron';
        chevron.textContent = '▶';

        const groupName = document.createElement('h3');
        groupName.className = 'group-name';
        groupName.textContent = group.name;

        const groupActions = document.createElement('div');
        groupActions.className = 'group-actions';

        const addBtn = document.createElement('button');
        addBtn.className = 'group-action-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add sounds to group';
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addSoundsToGroup(groupIndex);
        });

        const renameBtn = document.createElement('button');
        renameBtn.className = 'group-action-btn';
        renameBtn.textContent = '✏';
        renameBtn.title = 'Rename group';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.renameGroup(groupIndex);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'group-action-btn group-action-btn-danger';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Delete group';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteGroup(groupIndex);
        });

        groupActions.appendChild(addBtn);
        groupActions.appendChild(renameBtn);
        groupActions.appendChild(deleteBtn);

        headerContent.appendChild(chevron);
        headerContent.appendChild(groupName);
        headerContent.appendChild(groupActions);
        groupHeader.appendChild(headerContent);
        groupElement.appendChild(groupHeader);

        const groupSounds = document.createElement('div');
        groupSounds.className = 'group-sounds';

        group.sounds.forEach((sound, soundIndex) => {
            const globalIndex = this.getGlobalSoundIndex(groupIndex, soundIndex);
            const item = this.createSoundItem(sound, globalIndex);
            item.classList.add('grouped-sound');
            groupSounds.appendChild(item);
        });

        groupElement.appendChild(groupSounds);
        this.setupGroupCollapse(groupHeader, groupSounds);
        groupElement.classList.add('collapsed');
        groupSounds.style.display = 'none';

        return groupElement;
    }

    setupGroupCollapse(groupHeader, groupSounds) {
        const groupElement = groupHeader.parentElement;
        groupHeader.addEventListener('click', (e) => {
            // Don't toggle when clicking action buttons
            if (e.target.closest('.group-actions')) return;
            const isCollapsed = groupElement.classList.contains('collapsed');
            if (isCollapsed) {
                groupElement.classList.remove('collapsed');
                groupSounds.style.display = 'grid';
            } else {
                groupElement.classList.add('collapsed');
                groupSounds.style.display = 'none';
            }
        });
    }

    getGlobalSoundIndex(groupIndex, soundIndex) {
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

    getFlatSounds() {
        if (!this._flatSoundsCache) {
            const flat = [];
            this.sounds.forEach(sound => {
                if (sound.sounds && Array.isArray(sound.sounds)) {
                    flat.push(...sound.sounds);
                } else {
                    flat.push(sound);
                }
            });
            this._flatSoundsCache = flat;
        }
        return this._flatSoundsCache;
    }

    invalidateFlatSoundsCache() {
        this._flatSoundsCache = null;
    }

    createSoundItem(sound, index) {
        const defaultVolume = sound.volume || 80;
        const isInSession = this.sessionTracks.has(index);
        const item = document.createElement('div');
        item.className = 'sound-tile';
        if (!sound.audioId) item.classList.add('tile-error');
        item.innerHTML = `
            <div class="tile-header">
                <h3 class="sound-name"></h3>
                <div class="tile-actions">
                    <button class="tile-action-btn tile-rename-btn" data-index="${index}" title="Rename">✏</button>
                    <button class="tile-action-btn tile-delete-btn" data-index="${index}" title="Delete sound">×</button>
                    <button class="session-star-btn ${isInSession ? 'active' : ''}" data-index="${index}" title="${isInSession ? 'Remove from session' : 'Add to session'}">★</button>
                    <button class="loop-btn ${sound.loop ? 'active' : ''}" data-index="${index}" title="Loop">↻</button>
                </div>
            </div>

            <div class="tile-controls">
                <div class="playback-controls">
                    <button class="control-btn play-exclusive-btn" data-index="${index}" title="Play (Stop Others)">▶</button>
                    <button class="control-btn play-additive-btn" data-index="${index}" title="Play (Add)">+</button>
                    <button class="control-btn pause-btn" data-index="${index}" disabled title="Pause">⏸</button>
                    <button class="control-btn stop-btn" data-index="${index}" disabled title="Stop">■</button>
                </div>
            </div>

            <div class="volume-control">
                <div class="volume-slider-container">
                    <span class="volume-icon">♪</span> <input type="range" class="volume-slider individual-volume" data-index="${index}" min="0" max="100" value="${defaultVolume}">
                </div>
            </div>

            <div class="progress-control" data-index="${index}">
                <div class="progress-bar">
                    <div class="progress-fill"></div>
                    <div class="progress-handle"></div>
                </div>
            </div>
        `;

        const nameEl = item.querySelector('.sound-name');
        nameEl.textContent = sound.name;
        nameEl.title = sound.name;

        this.setupSoundControls(item, index);
        return item;
    }

    setupSoundControls(item, index) {
        const playExclusiveBtn = item.querySelector('.play-exclusive-btn');
        const playAdditiveBtn = item.querySelector('.play-additive-btn');
        const pauseBtn = item.querySelector('.pause-btn');
        const stopBtn = item.querySelector('.stop-btn');
        const loopBtn = item.querySelector('.loop-btn');
        const volumeSlider = item.querySelector('.individual-volume');
        const sessionStarBtn = item.querySelector('.session-star-btn');
        const renameBtn = item.querySelector('.tile-rename-btn');
        const deleteBtn = item.querySelector('.tile-delete-btn');

        playExclusiveBtn.addEventListener('click', () => this.playSound(index, true));
        playAdditiveBtn.addEventListener('click', () => this.playSound(index, false));
        pauseBtn.addEventListener('click', () => this.pauseSound(index));
        stopBtn.addEventListener('click', () => this.stopSound(index));
        loopBtn.addEventListener('click', () => this.toggleLoop(index, !loopBtn.classList.contains('active')));
        volumeSlider.addEventListener('input', (e) => this.setIndividualVolume(index, e.target.value));
        sessionStarBtn.addEventListener('click', () => this.toggleSessionTrack(index));
        renameBtn.addEventListener('click', () => this.renameSound(index));
        deleteBtn.addEventListener('click', () => this.deleteSound(index));

        this.setupProgressControls(item, index);
    }

    setupProgressControls(item, index) {
        const progressControl = item.querySelector('.progress-control');
        const progressBar = item.querySelector('.progress-bar');
        const progressHandle = item.querySelector('.progress-handle');

        let isDragging = false;
        let dragStartX = 0;
        let dragStartProgress = 0;

        progressBar.addEventListener('click', (e) => {
            if (isDragging) return;
            const audio = this.audioElements.get(index);
            if (!audio || !audio.duration) return;
            const rect = progressBar.getBoundingClientRect();
            const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            audio.currentTime = progress * audio.duration;
            this.updateProgress(index, progress);
        });

        const startDrag = (e) => {
            e.preventDefault();
            isDragging = true;
            progressControl.classList.add('dragging');
            const audio = this.audioElements.get(index);
            if (!audio || !audio.duration) return;
            dragStartX = e.clientX;
            dragStartProgress = audio.currentTime / audio.duration;
            document.addEventListener('mousemove', handleDrag);
            document.addEventListener('mouseup', endDrag);
        };

        const handleDrag = (e) => {
            if (!isDragging) return;
            const audio = this.audioElements.get(index);
            if (!audio || !audio.duration) return;
            const rect = progressBar.getBoundingClientRect();
            const newProgress = Math.max(0, Math.min(1, dragStartProgress + (e.clientX - dragStartX) / rect.width));
            this.updateProgress(index, newProgress);
        };

        const endDrag = (e) => {
            if (!isDragging) return;
            isDragging = false;
            progressControl.classList.remove('dragging');
            const audio = this.audioElements.get(index);
            if (audio && audio.duration) {
                const rect = progressBar.getBoundingClientRect();
                const newProgress = Math.max(0, Math.min(1, dragStartProgress + (e.clientX - dragStartX) / rect.width));
                audio.currentTime = newProgress * audio.duration;
            }
            document.removeEventListener('mousemove', handleDrag);
            document.removeEventListener('mouseup', endDrag);
        };

        progressHandle.addEventListener('mousedown', startDrag);
        progressHandle.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    updateProgress(index, progress) {
        const tiles = document.querySelectorAll(`[data-index="${index}"].progress-control`);
        tiles.forEach(tile => {
            const fill = tile.querySelector('.progress-fill');
            const handle = tile.querySelector('.progress-handle');
            const bar = tile.querySelector('.progress-bar');
            if (fill) fill.style.width = `${progress * 100}%`;
            if (handle && bar) {
                handle.style.left = `${progress * (bar.offsetWidth - 12)}px`;
                handle.style.right = 'auto';
            }
        });
    }

    updateEmptyState() {
        const emptyState = document.getElementById('empty-state');
        const soundList = document.getElementById('sound-list');
        if (!emptyState) return;

        const hasPacks = this.currentPack != null;
        emptyState.style.display = hasPacks ? 'none' : 'block';
        if (soundList) soundList.style.display = hasPacks ? '' : 'none';
    }

    // ─── Global Controls ─────────────────────────────────────────────────

    setupGlobalControls() {
        document.getElementById('stop-all-btn').addEventListener('click', () => this.stopAllSounds());
        document.getElementById('global-volume-slider').addEventListener('input', (e) => this.setGlobalVolume(e.target.value));
        document.getElementById('sound-pack-select').addEventListener('change', (e) => this.switchPack(e.target.value));
        document.getElementById('reset-settings-btn').addEventListener('click', () => this.resetAllSettings());
        document.getElementById('export-settings-btn').addEventListener('click', () => this.exportSettings());

        // Pack management buttons
        document.getElementById('new-pack-btn').addEventListener('click', () => this.createPack());
        document.getElementById('rename-pack-btn').addEventListener('click', () => this.renamePack());
        document.getElementById('delete-pack-btn').addEventListener('click', () => this.deleteCurrentPack());
        document.getElementById('import-pack-btn').addEventListener('click', () => this.importPack());

        this.setupSearchBar();
    }

    setupSearchBar() {
        const searchInput = document.getElementById('search-input');
        if (!searchInput) return;
        searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.toLowerCase().trim();
            this.filterSounds();
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
                e.preventDefault();
                window.location.reload();
            }
        });
    }

    filterSounds() {
        const query = this.searchQuery;
        document.querySelectorAll('.sound-group:not(.session-group)').forEach(group => {
            const tiles = group.querySelectorAll('.sound-tile');
            let anyMatch = false;
            tiles.forEach(tile => {
                const name = tile.querySelector('.sound-name').textContent.toLowerCase();
                const matches = !query || name.includes(query);
                tile.style.display = matches ? '' : 'none';
                if (matches) anyMatch = true;
            });
            group.style.display = (anyMatch || tiles.length === 0) ? '' : 'none';
        });
        document.querySelectorAll('#sound-list > .sound-tile').forEach(tile => {
            const name = tile.querySelector('.sound-name').textContent.toLowerCase();
            tile.style.display = (!query || name.includes(query)) ? '' : 'none';
        });
    }

    // ─── Now Playing ─────────────────────────────────────────────────────

    updateNowPlaying() {
        const container = document.getElementById('now-playing');
        if (!container) return;
        container.innerHTML = '';

        if (this.playingAudios.size === 0) {
            container.classList.remove('visible');
            return;
        }

        const flatSounds = this.getFlatSounds();
        this.playingAudios.forEach(index => {
            const sound = flatSounds[index];
            if (!sound) return;
            const pill = document.createElement('span');
            pill.className = 'now-playing-pill';
            pill.textContent = sound.name;
            const stopBtn = document.createElement('button');
            stopBtn.className = 'now-playing-stop';
            stopBtn.textContent = '×';
            stopBtn.title = 'Stop';
            stopBtn.addEventListener('click', () => this.stopSound(index));
            pill.appendChild(stopBtn);
            container.appendChild(pill);
        });
        container.classList.add('visible');
    }

    // ─── Playback ────────────────────────────────────────────────────────

    async playSound(index, exclusive = false) {
        try {
            if (exclusive) this.stopAllSounds();

            let audio = this.audioElements.get(index);
            const flatSounds = this.getFlatSounds();
            const sound = flatSounds[index];
            if (!sound) return;

            if (!audio) {
                const url = await this.store.getAudioUrl(sound.audioId);
                if (!url) {
                    this.updateSoundStatus(index, 'File not found');
                    return;
                }
                audio = new Audio(url);
                audio.addEventListener('ended', () => this.onSoundEnded(index));
                audio.addEventListener('error', (e) => this.onSoundError(index, e));
                audio.addEventListener('timeupdate', () => this.onTimeUpdate(index));
                audio.addEventListener('loadedmetadata', () => this.updateProgress(index, 0));
                this.audioElements.set(index, audio);
            }

            const loopBtn = document.querySelector(`[data-index="${index}"].loop-btn`);
            audio.loop = loopBtn ? loopBtn.classList.contains('active') : false;
            this.updateAudioVolume(index);

            if (audio.ended) audio.currentTime = 0;

            await audio.play();
            this.playingAudios.add(index);
            this.updateSoundControls(index, 'playing');
            this.updateNowPlaying();
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
            this.updateNowPlaying();
        }
    }

    stopSound(index) {
        const audio = this.audioElements.get(index);
        if (audio) {
            audio.pause();
            audio.currentTime = 0;
            this.playingAudios.delete(index);
            this.updateSoundControls(index, 'stopped');
            this.updateProgress(index, 0);
            this.updateNowPlaying();
        }
    }

    stopAllSounds() {
        const playingCount = this.playingAudios.size;
        this.audioElements.forEach((audio, index) => {
            if (!audio.paused) this.stopSound(index);
        });
        this.updateNowPlaying();
    }

    toggleLoop(index, shouldLoop) {
        const audio = this.audioElements.get(index);
        if (audio) audio.loop = shouldLoop;

        document.querySelectorAll(`[data-index="${index}"].loop-btn`).forEach(btn => {
            btn.classList.toggle('active', shouldLoop);
        });

        const flatSounds = this.getFlatSounds();
        if (flatSounds[index]) {
            flatSounds[index].loop = shouldLoop;
            this.savePackDebounced();
        }
    }

    onSoundEnded(index) {
        this.playingAudios.delete(index);
        this.updateSoundControls(index, 'stopped');
        this.updateProgress(index, 0);
        this.updateNowPlaying();
    }

    onSoundError(index, error) {
        console.error(`Sound ${index} error:`, error);
        this.playingAudios.delete(index);
        this.updateSoundControls(index, 'error');
        this.updateSoundStatus(index, 'File not found');
        this.updateNowPlaying();
    }

    onTimeUpdate(index) {
        const audio = this.audioElements.get(index);
        if (audio && audio.duration) {
            this.updateProgress(index, audio.currentTime / audio.duration);
        }
    }

    updateSoundControls(index, state) {
        const isPlaying = state === 'playing';
        const isStopped = state === 'paused' || state === 'stopped' || state === 'error';

        document.querySelectorAll(`[data-index="${index}"].play-exclusive-btn`).forEach(btn => {
            btn.disabled = isPlaying;
            const tile = btn.closest('.sound-tile');
            if (tile) {
                if (isPlaying) tile.classList.add('playing');
                if (isStopped) tile.classList.remove('playing');
            }
        });
        document.querySelectorAll(`[data-index="${index}"].play-additive-btn`).forEach(btn => btn.disabled = isPlaying);
        document.querySelectorAll(`[data-index="${index}"].pause-btn`).forEach(btn => btn.disabled = !isPlaying);
        document.querySelectorAll(`[data-index="${index}"].stop-btn`).forEach(btn => btn.disabled = !isPlaying);
    }

    updateSoundStatus(index, status) {
        document.querySelectorAll(`[data-index="${index}"]`).forEach(el => {
            const tile = el.closest('.sound-tile');
            if (!tile) return;
            tile.classList.remove('tile-loading', 'tile-error', 'tile-paused');
            if (status === 'Loading...') tile.classList.add('tile-loading');
            else if (status === 'File not found' || status.startsWith('Error:')) tile.classList.add('tile-error');
            else if (status === 'Paused') tile.classList.add('tile-paused');
        });
    }

    // ─── Volume ──────────────────────────────────────────────────────────

    setGlobalVolume(value) {
        this.globalVolume = value / 100;
        this.audioElements.forEach((_, index) => this.updateAudioVolume(index));
        this.savePackDebounced();
    }

    setIndividualVolume(index, value) {
        const newVolume = parseInt(value);
        const flatSounds = this.getFlatSounds();
        if (flatSounds[index]) {
            flatSounds[index].volume = newVolume;
            this.updateOriginalSoundVolume(index, newVolume);
            document.querySelectorAll(`[data-index="${index}"].individual-volume`).forEach(s => s.value = newVolume);
            this.updateAudioVolume(index);
            this.savePackDebounced();
        }
    }

    updateOriginalSoundVolume(flatIndex, newVolume) {
        let currentIndex = 0;
        for (let i = 0; i < this.sounds.length; i++) {
            if (this.sounds[i].sounds && Array.isArray(this.sounds[i].sounds)) {
                for (let j = 0; j < this.sounds[i].sounds.length; j++) {
                    if (currentIndex === flatIndex) { this.sounds[i].sounds[j].volume = newVolume; return; }
                    currentIndex++;
                }
            } else {
                if (currentIndex === flatIndex) { this.sounds[i].volume = newVolume; return; }
                currentIndex++;
            }
        }
    }

    updateAudioVolume(index) {
        const audio = this.audioElements.get(index);
        if (!audio) return;
        const flatSounds = this.getFlatSounds();
        const sound = flatSounds[index];
        if (sound) {
            audio.volume = Math.max(0, Math.min(1, this.globalVolume * ((sound.volume || 80) / 100)));
        }
    }

    // ─── Session Tracks ──────────────────────────────────────────────────

    loadSessionFromStorage() {
        try {
            const key = `soundTapSession_${this.currentPackId}`;
            const saved = localStorage.getItem(key);
            if (saved) {
                const savedIds = JSON.parse(saved);
                const flatSounds = this.getFlatSounds();
                this.sessionTracks = new Set();
                savedIds.forEach(id => {
                    if (typeof id === 'number') {
                        if (id < flatSounds.length) this.sessionTracks.add(id);
                    } else {
                        // audioId-based lookup
                        const idx = flatSounds.findIndex(s => s.audioId === id);
                        if (idx !== -1) this.sessionTracks.add(idx);
                    }
                });
            } else {
                this.sessionTracks = new Set();
            }
        } catch (error) {
            this.sessionTracks = new Set();
        }
    }

    saveSessionToStorage() {
        try {
            const key = `soundTapSession_${this.currentPackId}`;
            const flatSounds = this.getFlatSounds();
            const ids = [...this.sessionTracks].map(idx => flatSounds[idx]?.audioId).filter(Boolean);
            localStorage.setItem(key, JSON.stringify(ids));
        } catch (error) {
            console.error('Failed to save session:', error);
        }
    }

    toggleSessionTrack(index) {
        const wasInSession = this.sessionTracks.has(index);
        if (wasInSession) this.sessionTracks.delete(index);
        else this.sessionTracks.add(index);
        this.saveSessionToStorage();

        document.querySelectorAll(`[data-index="${index}"].session-star-btn`).forEach(btn => {
            btn.classList.toggle('active', !wasInSession);
            btn.title = !wasInSession ? 'Remove from session' : 'Add to session';
        });

        if (wasInSession) this.removeSessionTile(index);
        else this.addSessionTile(index);
    }

    addSessionTile(index) {
        const soundList = document.getElementById('sound-list');
        let sessionGroup = soundList.querySelector('.session-group');

        if (!sessionGroup) {
            sessionGroup = document.createElement('div');
            sessionGroup.className = 'sound-group session-group';
            const sessionHeader = document.createElement('div');
            sessionHeader.className = 'group-header session-header';
            sessionHeader.innerHTML = `
                <div class="group-header-content">
                    <h3 class="group-name">Session</h3>
                    <button class="clear-session-btn" title="Clear session selection">Clear</button>
                </div>
            `;
            sessionHeader.style.cursor = 'default';
            sessionGroup.appendChild(sessionHeader);
            const sessionSounds = document.createElement('div');
            sessionSounds.className = 'group-sounds';
            sessionSounds.style.display = 'grid';
            sessionGroup.appendChild(sessionSounds);
            soundList.insertBefore(sessionGroup, soundList.firstChild);
            sessionHeader.querySelector('.clear-session-btn').addEventListener('click', () => this.clearSession());
        }

        const sessionSounds = sessionGroup.querySelector('.group-sounds');
        const flatSounds = this.getFlatSounds();
        const sound = flatSounds[index];
        if (!sound) return;

        const item = this.createSoundItem(sound, index);
        item.classList.add('session-sound');

        let inserted = false;
        for (const tile of sessionSounds.querySelectorAll('.session-sound')) {
            if (index < parseInt(tile.querySelector('[data-index]').dataset.index)) {
                sessionSounds.insertBefore(item, tile);
                inserted = true;
                break;
            }
        }
        if (!inserted) sessionSounds.appendChild(item);

        if (this.playingAudios.has(index)) this.updateSoundControls(index, 'playing');
    }

    removeSessionTile(index) {
        const sessionGroup = document.querySelector('.session-group');
        if (!sessionGroup) return;
        const sessionSounds = sessionGroup.querySelector('.group-sounds');
        sessionSounds.querySelectorAll('.session-sound').forEach(tile => {
            if (parseInt(tile.querySelector('[data-index]').dataset.index) === index) tile.remove();
        });
        if (this.sessionTracks.size === 0) sessionGroup.remove();
    }

    clearSession() {
        const indices = [...this.sessionTracks];
        this.sessionTracks.clear();
        this.saveSessionToStorage();
        const sessionGroup = document.querySelector('.session-group');
        if (sessionGroup) sessionGroup.remove();
        indices.forEach(index => {
            document.querySelectorAll(`[data-index="${index}"].session-star-btn`).forEach(btn => {
                btn.classList.remove('active');
                btn.title = 'Add to session';
            });
        });
    }

    // ─── Pack Management ─────────────────────────────────────────────────

    async createPack() {
        const name = prompt('New pack name:');
        if (!name || !name.trim()) return;

        const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const existing = await this.store.getPack(id);
        if (existing) {
            this.showNotification('A pack with that name already exists', 'error');
            return;
        }

        await this.store.savePack({
            id,
            name: name.trim(),
            globalVolume: 80,
            sounds: [],
            createdAt: Date.now()
        });

        this.stopAllSounds();
        this.audioElements.clear();
        this.playingAudios.clear();
        await this.loadPack(id);
        await this.loadPackList();
        this.renderSounds();
        this.showNotification(`Pack "${name.trim()}" created`, 'info');
    }

    async renamePack() {
        if (!this.currentPack) return;
        const name = prompt('Rename pack:', this.currentPack.name);
        if (!name || !name.trim() || name.trim() === this.currentPack.name) return;

        this.currentPack.name = name.trim();
        await this.store.savePack(this.currentPack);
        await this.loadPackList();
        this.showNotification(`Pack renamed to "${name.trim()}"`, 'info');
    }

    async deleteCurrentPack() {
        if (!this.currentPack) return;
        if (!confirm(`Delete pack "${this.currentPack.name}" and all its audio files?\n\nThis cannot be undone.`)) return;

        this.stopAllSounds();
        this.audioElements.clear();
        this.playingAudios.clear();
        this.store.revokeUrls();

        await this.store.deletePack(this.currentPackId);

        const packs = await this.store.getAllPacks();
        if (packs.length > 0) {
            await this.loadPack(packs[0].id);
        } else {
            this.currentPack = null;
            this.currentPackId = null;
            this.sounds = [];
            this.invalidateFlatSoundsCache();
            localStorage.removeItem('soundTapApp');
        }

        await this.loadPackList();
        this.renderSounds();
        this.showNotification('Pack deleted', 'info');
    }

    async importPack() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);

                if (!data.sounds || !Array.isArray(data.sounds)) {
                    this.showNotification('Invalid pack format: missing "sounds" array', 'error');
                    return;
                }

                const baseName = file.name.replace('.json', '').replace(/[-_]/g, ' ').trim();
                const name = prompt('Pack name:', baseName) || baseName;
                const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

                // Check for audioId-based pack (previously exported from this app)
                const hasAudioIds = this._checkHasAudioIds(data.sounds);

                let sounds;
                if (hasAudioIds) {
                    // Directly import — audio is already in IndexedDB or will be added separately
                    sounds = data.sounds;
                } else {
                    // Legacy file-path-based pack — ask user for audio files
                    const filePaths = this._collectFilePaths(data.sounds);
                    if (filePaths.length > 0) {
                        this.showNotification(`Select ${filePaths.length} audio file(s) to import`, 'info');
                        const audioFiles = await this._pickAudioFiles();
                        if (!audioFiles) return;

                        const fileMap = new Map();
                        for (const af of audioFiles) {
                            fileMap.set(af.name, af);
                            // Also map by path basename for matching
                            const pathBaseName = af.name.split('/').pop();
                            fileMap.set(pathBaseName, af);
                        }

                        sounds = await this._importSoundsWithFiles(data.sounds, fileMap);
                    } else {
                        sounds = data.sounds;
                    }
                }

                await this.store.savePack({
                    id,
                    name,
                    globalVolume: data.globalVolume || 80,
                    sounds,
                    createdAt: Date.now()
                });

                this.stopAllSounds();
                this.audioElements.clear();
                this.playingAudios.clear();
                await this.loadPack(id);
                await this.loadPackList();
                this.renderSounds();
                await this.checkAudioFiles();
                this.showNotification(`Pack "${name}" imported`, 'info');
            } catch (err) {
                console.error('Import failed:', err);
                this.showNotification('Import failed: ' + err.message, 'error');
            }
        });
        input.click();
    }

    _checkHasAudioIds(sounds) {
        for (const s of sounds) {
            if (s.sounds && Array.isArray(s.sounds)) {
                if (this._checkHasAudioIds(s.sounds)) return true;
            } else if (s.audioId) {
                return true;
            }
        }
        return false;
    }

    _collectFilePaths(sounds) {
        const paths = [];
        for (const s of sounds) {
            if (s.sounds && Array.isArray(s.sounds)) {
                paths.push(...this._collectFilePaths(s.sounds));
            } else if (s.file) {
                paths.push(s.file);
            }
        }
        return paths;
    }

    _pickAudioFiles() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = 'audio/*';
            input.addEventListener('change', () => resolve(input.files.length > 0 ? input.files : null));
            // If user cancels, resolve null after a timeout
            input.addEventListener('cancel', () => resolve(null));
            input.click();
        });
    }

    async _importSoundsWithFiles(sounds, fileMap) {
        const result = [];
        for (const entry of sounds) {
            if (entry.sounds && Array.isArray(entry.sounds)) {
                const groupSounds = await this._importSoundsWithFiles(entry.sounds, fileMap);
                result.push({ name: entry.name, sounds: groupSounds });
            } else {
                let audioId = null;
                if (entry.file) {
                    const fileName = entry.file.split('/').pop();
                    const audioFile = fileMap.get(fileName) || fileMap.get(entry.file);
                    if (audioFile) {
                        audioId = await this.store.saveAudio(audioFile);
                    }
                }
                result.push({
                    name: entry.name,
                    audioId,
                    volume: entry.volume || 80,
                    loop: entry.loop || false
                });
            }
        }
        return result;
    }

    async switchPack(packId) {
        if (packId === this.currentPackId) return;
        this.stopAllSounds();
        this.audioElements.clear();
        this.playingAudios.clear();

        await this.loadPack(packId);

        this.searchQuery = '';
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = '';

        this.renderSounds();
        this.updateNowPlaying();
        await this.checkAudioFiles();
    }

    // ─── Group Management ────────────────────────────────────────────────

    async addGroup() {
        const name = prompt('Group name:');
        if (!name || !name.trim()) return;

        this.sounds.push({ name: name.trim(), sounds: [] });
        this.invalidateFlatSoundsCache();
        await this.savePack();
        this.renderSounds();
        this.restorePlayingStates();
        this.filterSounds();
    }

    async renameGroup(groupIndex) {
        const group = this.sounds[groupIndex];
        if (!group) return;
        const name = prompt('Rename group:', group.name);
        if (!name || !name.trim() || name.trim() === group.name) return;

        group.name = name.trim();
        await this.savePack();
        this.renderSounds();
        this.restorePlayingStates();
        this.filterSounds();
    }

    async deleteGroup(groupIndex) {
        const group = this.sounds[groupIndex];
        if (!group) return;
        const soundCount = group.sounds ? group.sounds.length : 0;
        if (!confirm(`Delete group "${group.name}"${soundCount > 0 ? ` and its ${soundCount} sound(s)` : ''}?`)) return;

        // Delete associated audio files
        if (group.sounds) {
            for (const sound of group.sounds) {
                if (sound.audioId) await this.store.deleteAudio(sound.audioId);
            }
        }

        this.sounds.splice(groupIndex, 1);
        this.invalidateFlatSoundsCache();

        // Clear audio elements and playing state since indices shifted
        this.stopAllSounds();
        this.audioElements.clear();
        this.playingAudios.clear();

        await this.savePack();
        this.renderSounds();
    }

    // ─── Sound Management ────────────────────────────────────────────────

    async addSoundsToGroup(groupIndex) {
        const files = await this._pickAudioFiles();
        if (!files) return;

        const group = this.sounds[groupIndex];
        if (!group || !group.sounds) return;

        for (const file of files) {
            const audioId = await this.store.saveAudio(file);
            const name = file.name.replace(/\.[^/.]+$/, '');
            group.sounds.push({ name, audioId, volume: 80, loop: false });
        }

        this.invalidateFlatSoundsCache();
        await this.savePack();
        this.renderSounds();
        this.restorePlayingStates();
        this.filterSounds();
        this.showNotification(`Added ${files.length} sound(s)`, 'info');
    }

    async addSoundsToTop() {
        const files = await this._pickAudioFiles();
        if (!files) return;

        for (const file of files) {
            const audioId = await this.store.saveAudio(file);
            const name = file.name.replace(/\.[^/.]+$/, '');
            this.sounds.push({ name, audioId, volume: 80, loop: false });
        }

        this.invalidateFlatSoundsCache();
        await this.savePack();
        this.renderSounds();
        this.restorePlayingStates();
        this.filterSounds();
        this.showNotification(`Added ${files.length} sound(s)`, 'info');
    }

    async renameSound(flatIndex) {
        const flatSounds = this.getFlatSounds();
        const sound = flatSounds[flatIndex];
        if (!sound) return;

        const name = prompt('Rename sound:', sound.name);
        if (!name || !name.trim() || name.trim() === sound.name) return;

        sound.name = name.trim();
        await this.savePack();

        // Update DOM in place
        document.querySelectorAll(`[data-index="${flatIndex}"]`).forEach(el => {
            const tile = el.closest('.sound-tile');
            if (tile) {
                const nameEl = tile.querySelector('.sound-name');
                if (nameEl) {
                    nameEl.textContent = name.trim();
                    nameEl.title = name.trim();
                }
            }
        });
        this.updateNowPlaying();
    }

    async deleteSound(flatIndex) {
        const flatSounds = this.getFlatSounds();
        const sound = flatSounds[flatIndex];
        if (!sound) return;
        if (!confirm(`Delete sound "${sound.name}"?`)) return;

        // Remove audio from IndexedDB
        if (sound.audioId) await this.store.deleteAudio(sound.audioId);

        // Find and remove from nested structure
        this._removeSoundByFlatIndex(flatIndex);
        this.invalidateFlatSoundsCache();

        // Clear state since indices shifted
        this.stopAllSounds();
        this.audioElements.clear();
        this.playingAudios.clear();

        await this.savePack();
        this.renderSounds();
    }

    _removeSoundByFlatIndex(flatIndex) {
        let currentIndex = 0;
        for (let i = 0; i < this.sounds.length; i++) {
            if (this.sounds[i].sounds && Array.isArray(this.sounds[i].sounds)) {
                for (let j = 0; j < this.sounds[i].sounds.length; j++) {
                    if (currentIndex === flatIndex) {
                        this.sounds[i].sounds.splice(j, 1);
                        // Remove empty groups
                        if (this.sounds[i].sounds.length === 0) this.sounds.splice(i, 1);
                        return;
                    }
                    currentIndex++;
                }
            } else {
                if (currentIndex === flatIndex) {
                    this.sounds.splice(i, 1);
                    return;
                }
                currentIndex++;
            }
        }
    }

    // ─── Settings ────────────────────────────────────────────────────────

    async resetAllSettings() {
        if (!this.currentPack) return;
        if (!confirm('Reset all volume and loop settings to defaults?\n\nThis cannot be undone.')) return;

        const resetSounds = (sounds) => {
            for (const s of sounds) {
                if (s.sounds && Array.isArray(s.sounds)) {
                    resetSounds(s.sounds);
                } else {
                    s.volume = 80;
                    s.loop = false;
                }
            }
        };

        this.globalVolume = 0.8;
        resetSounds(this.sounds);
        this.currentPack.globalVolume = 80;
        await this.savePack();

        const slider = document.getElementById('global-volume-slider');
        if (slider) slider.value = 80;

        this.renderSounds();
        this.restorePlayingStates();
        this.showNotification('Settings reset to defaults', 'info');
    }

    exportSettings() {
        if (!this.currentPack) return;
        try {
            const exportData = {
                name: this.currentPack.name,
                globalVolume: Math.round(this.globalVolume * 100),
                sounds: this._exportSounds(this.sounds)
            };
            const jsonString = JSON.stringify(exportData, null, 4);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
            link.download = `sound-tap-${this.currentPackId}-${timestamp}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            this.showNotification('Pack exported! Check your downloads folder.', 'info');
        } catch (error) {
            this.showNotification('Export failed: ' + error.message, 'error');
        }
    }

    _exportSounds(sounds) {
        return sounds.map(s => {
            if (s.sounds && Array.isArray(s.sounds)) {
                return { name: s.name, sounds: this._exportSounds(s.sounds) };
            }
            return { name: s.name, audioId: s.audioId, volume: s.volume, loop: s.loop };
        });
    }

    restorePlayingStates() {
        this.playingAudios.forEach(index => this.updateSoundControls(index, 'playing'));
        this.updateNowPlaying();
    }

    // ─── Notifications ───────────────────────────────────────────────────

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        const offset = this._notificationCount * 52;
        notification.style.top = `${20 + offset}px`;
        this._notificationCount++;
        document.body.appendChild(notification);
        setTimeout(() => {
            if (notification.parentNode) notification.parentNode.removeChild(notification);
            this._notificationCount = Math.max(0, this._notificationCount - 1);
        }, 3000);
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new SoundTap();
});
