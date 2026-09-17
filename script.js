// ─── SoundStore: IndexedDB storage layer for audio blobs and pack metadata ───

class SoundStore {
    constructor() {
        this.db = null;
        this.blobUrlCache = new Map(); // audioId -> blobUrl
    }

    open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('SoundTapDB', 2);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('packs')) {
                    db.createObjectStore('packs', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('audio')) {
                    db.createObjectStore('audio', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('library')) {
                    db.createObjectStore('library', { keyPath: 'id' });
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
        const pack = await this.getPack(packId);
        if (pack) {
            const allPacks = await this.getAllPacks();
            const libraryIds = this._collectLibraryIds(pack.sounds || []);
            const otherLibraryIds = new Set();
            allPacks.forEach(p => {
                if (p.id !== packId) {
                    this._collectLibraryIds(p.sounds || []).forEach(id => otherLibraryIds.add(id));
                }
            });
            for (const libId of libraryIds) {
                if (!otherLibraryIds.has(libId)) {
                    const track = await this.getLibraryTrack(libId);
                    if (track && track.audioId) await this.deleteAudio(track.audioId);
                    await this.deleteLibraryTrack(libId);
                }
            }
        }
        const store = this._tx('packs', 'readwrite');
        return this._request(store, 'delete', packId);
    }

    _collectLibraryIds(sounds) {
        const ids = [];
        for (const s of sounds) {
            if (s.sounds && Array.isArray(s.sounds)) {
                ids.push(...this._collectLibraryIds(s.sounds));
            } else if (s.libraryId) {
                ids.push(s.libraryId);
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

    async getAudioRecord(audioId) {
        if (!audioId) return null;
        const store = this._tx('audio');
        return this._request(store, 'get', audioId);
    }

    async getAllAudioRecords() {
        const store = this._tx('audio');
        return this._request(store, 'getAll');
    }

    async getAudioBlob(audioId) {
        if (!audioId) return null;
        const record = await this.getAudioRecord(audioId);
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

    // ─── Library CRUD ─────────────────────────────────────────────────────

    async getAllLibraryTracks() {
        const store = this._tx('library');
        return this._request(store, 'getAll');
    }

    async getLibraryTrack(id) {
        const store = this._tx('library');
        return this._request(store, 'get', id);
    }

    async saveLibraryTrack(track) {
        const store = this._tx('library', 'readwrite');
        return this._request(store, 'put', track);
    }

    async deleteLibraryTrack(id) {
        const store = this._tx('library', 'readwrite');
        return this._request(store, 'delete', id);
    }
}

// ─── YouTubeAudioAdapter: wraps YT.Player to mimic HTML5 Audio interface ────

class YouTubeAudioAdapter {
    constructor(player) {
        this.player = player;
        this._loop = false;
        this._pollInterval = null;
        this._onEnded = null;
        this._onTimeUpdate = null;
        this._onError = null;
        this._ready = false;
        this._destroyed = false;
    }

    get paused() {
        if (!this._ready || this._destroyed) return true;
        const state = this.player.getPlayerState();
        return state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING;
    }

    get currentTime() {
        if (!this._ready || this._destroyed) return 0;
        return this.player.getCurrentTime() || 0;
    }

    set currentTime(t) {
        if (this._ready && !this._destroyed) this.player.seekTo(t, true);
    }

    get duration() {
        if (!this._ready || this._destroyed) return 0;
        return this.player.getDuration() || 0;
    }

    get ended() {
        if (!this._ready || this._destroyed) return false;
        return this.player.getPlayerState() === YT.PlayerState.ENDED;
    }

    get loop() { return this._loop; }
    set loop(v) { this._loop = v; }

    get volume() {
        if (!this._ready || this._destroyed) return 1;
        return (this.player.getVolume() || 0) / 100;
    }

    set volume(v) {
        if (this._ready && !this._destroyed) this.player.setVolume(Math.round(v * 100));
    }

    play() {
        if (!this._ready || this._destroyed) return Promise.resolve();
        this.player.playVideo();
        this._startPolling();
        return Promise.resolve();
    }

    pause() {
        if (this._ready && !this._destroyed) this.player.pauseVideo();
        this._stopPolling();
    }

    addEventListener(event, handler) {
        if (event === 'ended') this._onEnded = handler;
        else if (event === 'timeupdate') this._onTimeUpdate = handler;
        else if (event === 'error') this._onError = handler;
        else if (event === 'loadedmetadata') {
            // Fire immediately if ready, otherwise queue
            if (this._ready) handler();
            else this._onLoadedMetadata = handler;
        }
    }

    _handleStateChange(state) {
        if (state === YT.PlayerState.ENDED) {
            if (this._loop) {
                this.player.seekTo(0, true);
                this.player.playVideo();
            } else {
                this._stopPolling();
                if (this._onEnded) this._onEnded();
            }
        }
    }

    _startPolling() {
        this._stopPolling();
        this._pollInterval = setInterval(() => {
            if (this._onTimeUpdate && !this._destroyed) this._onTimeUpdate();
        }, 250);
    }

    _stopPolling() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this._stopPolling();
        try { this.player.destroy(); } catch (e) { /* ignore */ }
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
        this.pausedAudios = new Set();
        this.globalVolume = 0.8;
        this.searchQuery = '';
        this.sessionTracks = new Set();
        this._flatSoundsCache = null;
        this._libraryMap = new Map();
        this._saveTimeout = null;
        this._notificationCount = 0;
        this._ytApiReady = null;
        this._ytPlayerCounter = 0;
        this.scenes = [];
        this.activeSceneId = null;
        this.editingSceneId = null;
        this.fadeGains = new Map();
        this.fadeFrames = new Map();
        this.init();
    }

    // ─── Initialization ──────────────────────────────────────────────────

    async init() {
        try {
            await this.store.open();

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

            await this.loadPackList();

            if (this.currentPackId) {
                await this.loadPack(this.currentPackId);
            }

            // If the saved pack ID no longer exists, fall back to the first available pack
            if (!this.currentPack && packs.length > 0) {
                this.currentPackId = packs[0].id;
                await this.loadPack(this.currentPackId);
            }

            this.renderSounds();
            this.renderScenes();
            this.setupGlobalControls();
            this.setupKeyboardShortcuts();
            await this.checkAudioFiles();
            this.updateEmptyState();
            this.updateStorageUsage();
        } catch (error) {
            console.error('Failed to initialize:', error);
            this.showNotification('Error initializing app: ' + error.message, 'error');
        }
    }

    async _loadLibraryMap() {
        this._libraryMap.clear();
        const allTracks = await this.store.getAllLibraryTracks();
        for (const track of allTracks) {
            this._libraryMap.set(track.id, track);
        }
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
        this.scenes = pack.scenes || [];
        this.activeSceneId = null;
        this.editingSceneId = null;
        this.globalVolume = (pack.globalVolume || 80) / 100;
        this.invalidateFlatSoundsCache();
        await this._loadLibraryMap();
        this.loadSessionFromStorage();

        localStorage.setItem('soundTapApp', JSON.stringify({ currentPackId: this.currentPackId }));

        const globalVolumeSlider = document.getElementById('global-volume-slider');
        if (globalVolumeSlider) globalVolumeSlider.value = Math.round(this.globalVolume * 100);

        this.renderScenes();
    }

    async savePack() {
        if (!this.currentPack) return;
        this.currentPack.sounds = this.sounds;
        this.currentPack.scenes = this.scenes;
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
            if (sound && sound.youtubeId) continue; // YouTube sounds don't need local audio
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

        // Compute flat index for each top-level entry
        const flatIndices = [];
        let flatIdx = 0;
        for (let i = 0; i < this.sounds.length; i++) {
            flatIndices.push(flatIdx);
            if (this.sounds[i].sounds && Array.isArray(this.sounds[i].sounds)) {
                flatIdx += this.sounds[i].sounds.length;
            } else {
                flatIdx += 1;
            }
        }

        // Non-grouped sounds first, then groups
        const resolvedFlat = this.getFlatSounds();
        for (let i = 0; i < this.sounds.length; i++) {
            if (!(this.sounds[i].sounds && Array.isArray(this.sounds[i].sounds))) {
                soundList.appendChild(this.createSoundItem(resolvedFlat[flatIndices[i]], flatIndices[i]));
            }
        }
        for (let i = 0; i < this.sounds.length; i++) {
            if (this.sounds[i].sounds && Array.isArray(this.sounds[i].sounds)) {
                soundList.appendChild(this.createSoundGroup(this.sounds[i], i));
            }
        }

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

            const addYouTubeBtn = document.createElement('button');
            addYouTubeBtn.className = 'add-btn add-btn-youtube';
            addYouTubeBtn.textContent = '+ Add YouTube';
            addYouTubeBtn.addEventListener('click', () => this.addYouTubeToTop());

            addBar.appendChild(addGroupBtn);
            addBar.appendChild(addSoundBtn);
            addBar.appendChild(addYouTubeBtn);
            soundList.appendChild(addBar);
        }

        this.updateEmptyState();
        this.updateStorageUsage();
        this.updateSceneTileButtons();
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

        const addYtBtn = document.createElement('button');
        addYtBtn.className = 'group-action-btn group-action-btn-youtube';
        addYtBtn.textContent = 'YT';
        addYtBtn.title = 'Add YouTube sound to group';
        addYtBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addYouTubeToGroup(groupIndex);
        });

        groupActions.appendChild(addBtn);
        groupActions.appendChild(addYtBtn);
        groupActions.appendChild(renameBtn);
        groupActions.appendChild(deleteBtn);

        headerContent.appendChild(chevron);
        headerContent.appendChild(groupName);
        headerContent.appendChild(groupActions);
        groupHeader.appendChild(headerContent);
        groupElement.appendChild(groupHeader);

        const groupSounds = document.createElement('div');
        groupSounds.className = 'group-sounds';

        const resolvedFlat = this.getFlatSounds();
        group.sounds.forEach((sound, soundIndex) => {
            const globalIndex = this.getGlobalSoundIndex(groupIndex, soundIndex);
            const item = this.createSoundItem(resolvedFlat[globalIndex] || sound, globalIndex);
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

    /* The stored sound objects in playback order. getFlatSounds() returns
       resolved *copies* for library-backed sounds, so anything that needs
       object identity (moving, session tracking) has to use these. */
    getRawFlatSounds() {
        const flat = [];
        this.sounds.forEach(sound => {
            if (sound.sounds && Array.isArray(sound.sounds)) {
                flat.push(...sound.sounds);
            } else {
                flat.push(sound);
            }
        });
        return flat;
    }

    getFlatSounds() {
        if (!this._flatSoundsCache) {
            const flat = this.getRawFlatSounds();
            this._flatSoundsCache = flat.map(s => {
                if (s.libraryId) {
                    const lib = this._libraryMap.get(s.libraryId);
                    if (lib) {
                        return { ...s, name: lib.name, audioId: lib.audioId, youtubeId: lib.youtubeId };
                    }
                }
                return s;
            });
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
        if (sound.youtubeId) item.classList.add('youtube-sound');
        else if (!sound.audioId) item.classList.add('tile-error');
        item.innerHTML = `
            <div class="tile-top-icons">
                <button class="session-star-btn ${isInSession ? 'active' : ''}" data-index="${index}" title="${isInSession ? 'Remove from session' : 'Add to session'}">★</button>
                <button class="loop-btn ${sound.loop ? 'active' : ''}" data-index="${index}" title="Loop">↻</button>
                <button class="tile-action-btn tile-move-btn" data-index="${index}" title="Move to group">📁</button>
                <button class="tile-action-btn tile-delete-btn" data-index="${index}" title="Delete sound">🗑</button>
                <button class="tile-action-btn tile-scene-btn" data-index="${index}" title="Add to scene">+</button>
            </div>
            <div class="tile-name-row">
                ${sound.youtubeId ? '<span class="youtube-badge">YT</span>' : ''}
                <h3 class="sound-name"></h3>
            </div>

            <div class="tile-controls">
                <div class="playback-controls">
                    <button class="control-btn play-exclusive-btn" data-index="${index}" title="Play (Stop Others)">▶</button>
                    <button class="control-btn play-additive-btn" data-index="${index}" title="Play (Add)">+</button>
                    <button class="control-btn pause-btn" data-index="${index}" hidden title="Pause">⏸</button>
                    <button class="control-btn stop-btn" data-index="${index}" hidden title="Stop">■</button>
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
        nameEl.title = `${sound.name}\n(click to rename)`;

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
        const nameEl = item.querySelector('.sound-name');
        const sceneBtn = item.querySelector('.tile-scene-btn');
        const moveBtn = item.querySelector('.tile-move-btn');
        const deleteBtn = item.querySelector('.tile-delete-btn');

        playExclusiveBtn.addEventListener('click', () => this.playSound(index, true));
        playAdditiveBtn.addEventListener('click', () => this.playSound(index, false));
        pauseBtn.addEventListener('click', () => this.pauseSound(index));
        stopBtn.addEventListener('click', () => this.stopSound(index));
        loopBtn.addEventListener('click', () => this.toggleLoop(index, !loopBtn.classList.contains('active')));
        volumeSlider.addEventListener('input', (e) => this.setIndividualVolume(index, e.target.value));
        sessionStarBtn.addEventListener('click', () => this.toggleSessionTrack(index));
        nameEl.addEventListener('click', () => this.renameSound(index));
        sceneBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleTrackInScene(index);
        });
        moveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._openMoveMenu(moveBtn, index);
        });
        deleteBtn.addEventListener('click', () => this.deleteSound(index));

        const ytBadge = item.querySelector('.youtube-badge');
        if (ytBadge) {
            ytBadge.style.cursor = 'pointer';
            ytBadge.addEventListener('click', () => {
                const sound = this.getFlatSounds()[index];
                if (sound && sound.youtubeId) {
                    const url = `https://www.youtube.com/watch?v=${sound.youtubeId}`;
                    navigator.clipboard.writeText(url).then(() => {
                        ytBadge.textContent = '✓';
                        setTimeout(() => { ytBadge.textContent = 'YT'; }, 1000);
                    });
                }
            });
        }

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

    async updateStorageUsage() {
        const el = document.getElementById('storage-usage');
        if (!el) return;
        try {
            if (navigator.storage && navigator.storage.estimate) {
                const { usage, quota } = await navigator.storage.estimate();
                const fmt = (bytes) => {
                    if (bytes < 1024) return bytes + ' B';
                    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
                    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
                    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
                };
                el.textContent = `Storage: ${fmt(usage)} / ${fmt(quota)}`;
            }
        } catch { /* ignore */ }
    }

    // ─── Global Controls ─────────────────────────────────────────────────

    setupGlobalControls() {
        document.getElementById('stop-all-btn').addEventListener('click', () => this.stopAllSounds());
        document.getElementById('global-volume-slider').addEventListener('input', (e) => this.setGlobalVolume(e.target.value));
        document.getElementById('sound-pack-select').addEventListener('change', (e) => this.switchPack(e.target.value));
        document.getElementById('reset-settings-btn').addEventListener('click', () => this.resetAllSettings());
        document.getElementById('export-settings-btn').addEventListener('click', () => this.exportSettings());
        document.getElementById('clear-storage-btn').addEventListener('click', () => this.clearStorage());
        document.getElementById('backup-btn').addEventListener('click', () => this.fullBackup());
        document.getElementById('restore-btn').addEventListener('click', () => this.restoreBackup());

        // Pack management buttons
        document.getElementById('new-pack-btn').addEventListener('click', () => this.createPack());
        document.getElementById('rename-pack-btn').addEventListener('click', () => this.renamePack());
        document.getElementById('delete-pack-btn').addEventListener('click', () => this.deleteCurrentPack());
        document.getElementById('import-pack-btn').addEventListener('click', () => this.importPack());
        this.setupSceneControls();

        const viewLibraryBtn = document.getElementById('view-library-btn');
        if (viewLibraryBtn) {
            viewLibraryBtn.addEventListener('click', () => this.openLibraryModal());
        }

        const libraryModalClose = document.getElementById('library-modal-close');
        if (libraryModalClose) {
            libraryModalClose.addEventListener('click', () => this.closeLibraryModal());
        }

        const libraryBackdrop = document.querySelector('.library-modal-backdrop');
        if (libraryBackdrop) {
            libraryBackdrop.addEventListener('click', () => this.closeLibraryModal());
        }

        const librarySearchInput = document.getElementById('library-search-input');
        if (librarySearchInput) {
            librarySearchInput.addEventListener('input', (e) => this.filterLibraryTracks(e.target.value));
        }

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

        const active = [...new Set([...this.playingAudios, ...this.pausedAudios])].sort((a, b) => a - b);
        if (active.length === 0) {
            container.classList.remove('visible');
            return;
        }

        const flatSounds = this.getFlatSounds();
        active.forEach(index => {
            const sound = flatSounds[index];
            if (!sound) return;
            const isPlaying = this.playingAudios.has(index);

            const pill = document.createElement('span');
            pill.className = `now-playing-pill ${isPlaying ? 'playing' : 'paused'}`;

            const name = document.createElement('span');
            name.className = 'now-playing-name';
            name.textContent = sound.name;
            name.title = sound.name;
            pill.appendChild(name);

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'now-playing-toggle';
            toggleBtn.textContent = isPlaying ? '⏸' : '▶';
            toggleBtn.title = isPlaying ? 'Pause' : 'Play';
            toggleBtn.addEventListener('click', () => {
                if (isPlaying) this.pauseSound(index);
                else this.playSound(index, false);
            });
            pill.appendChild(toggleBtn);

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

    _destroyAllAudioElements() {
        this.fadeFrames.forEach(frame => cancelAnimationFrame(frame));
        this.fadeFrames.clear();
        this.fadeGains.clear();
        this.audioElements.forEach(audio => {
            if (audio instanceof YouTubeAudioAdapter) audio.destroy();
        });
        this.audioElements.clear();
    }

    // ─── Playback ────────────────────────────────────────────────────────

    async playSound(index, exclusive = false, keepFade = false) {
        try {
            if (!keepFade) {
                this._cancelFade(index);
                this.fadeGains.delete(index);
            }
            if (exclusive) this.stopAllSounds();

            let audio = this.audioElements.get(index);
            const flatSounds = this.getFlatSounds();
            const sound = flatSounds[index];
            if (!sound) return;

            if (!audio) {
                if (sound.youtubeId) {
                    this.updateSoundStatus(index, 'Loading...');
                    await this._ensureYouTubeAPI();
                    audio = await this._createYouTubePlayer(sound.youtubeId);
                    audio.addEventListener('ended', () => this.onSoundEnded(index));
                    audio.addEventListener('error', (e) => this.onSoundError(index, e));
                    audio.addEventListener('timeupdate', () => this.onTimeUpdate(index));
                    audio.addEventListener('loadedmetadata', () => this.updateProgress(index, 0));
                    this.audioElements.set(index, audio);
                } else {
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
            }

            const loopBtn = document.querySelector(`[data-index="${index}"].loop-btn`);
            audio.loop = loopBtn ? loopBtn.classList.contains('active') : false;
            this.updateAudioVolume(index);

            if (audio.ended) audio.currentTime = 0;

            await audio.play();
            this.playingAudios.add(index);
            this.pausedAudios.delete(index);
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
            this.pausedAudios.add(index);
            this.updateSoundControls(index, 'paused');
            this.updateSoundStatus(index, 'Paused');
            this.updateNowPlaying();
        }
    }

    stopSound(index) {
        const audio = this.audioElements.get(index);
        if (audio) {
            this._cancelFade(index);
            this.fadeGains.delete(index);
            audio.pause();
            audio.currentTime = 0;
            this.playingAudios.delete(index);
            this.pausedAudios.delete(index);
            this.updateSoundControls(index, 'stopped');
            this.updateProgress(index, 0);
            this.updateNowPlaying();
        }
    }

    stopAllSounds() {
        this.audioElements.forEach((audio, index) => {
            if (!audio.paused || this.pausedAudios.has(index)) this.stopSound(index);
        });
        this.updateNowPlaying();
        if (this.activeSceneId) {
            this.activeSceneId = null;
            this.renderScenes();
        }
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
            this._updateOriginalSound(index, { loop: shouldLoop });
            this.savePackDebounced();
        }
    }

    onSoundEnded(index) {
        this.playingAudios.delete(index);
        this.pausedAudios.delete(index);
        this.updateSoundControls(index, 'stopped');
        this.updateProgress(index, 0);
        this.updateNowPlaying();
    }

    onSoundError(index, error) {
        console.error(`Sound ${index} error:`, error);
        this.playingAudios.delete(index);
        this.pausedAudios.delete(index);
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
            btn.hidden = isPlaying;
            const tile = btn.closest('.sound-tile');
            if (tile) {
                if (isPlaying) tile.classList.add('playing');
                if (isStopped) tile.classList.remove('playing');
            }
        });
        document.querySelectorAll(`[data-index="${index}"].play-additive-btn`).forEach(btn => btn.hidden = isPlaying);
        document.querySelectorAll(`[data-index="${index}"].pause-btn`).forEach(btn => btn.hidden = !isPlaying);
        document.querySelectorAll(`[data-index="${index}"].stop-btn`).forEach(btn => btn.hidden = !isPlaying);
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
            this._updateOriginalSound(index, { volume: newVolume });
            document.querySelectorAll(`[data-index="${index}"].individual-volume`).forEach(s => s.value = newVolume);
            this.updateAudioVolume(index);
            this.savePackDebounced();
        }
    }

    _updateOriginalSound(flatIndex, updates) {
        let currentIndex = 0;
        for (let i = 0; i < this.sounds.length; i++) {
            if (this.sounds[i].sounds && Array.isArray(this.sounds[i].sounds)) {
                for (let j = 0; j < this.sounds[i].sounds.length; j++) {
                    if (currentIndex === flatIndex) { Object.assign(this.sounds[i].sounds[j], updates); return; }
                    currentIndex++;
                }
            } else {
                if (currentIndex === flatIndex) { Object.assign(this.sounds[i], updates); return; }
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
            const fade = this.fadeGains.has(index) ? this.fadeGains.get(index) : 1;
            audio.volume = Math.max(0, Math.min(1, this.globalVolume * ((sound.volume || 80) / 100) * fade));
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
        this._destroyAllAudioElements();
        this.playingAudios.clear();
        this.pausedAudios.clear();
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
        this._destroyAllAudioElements();
        this.playingAudios.clear();
        this.pausedAudios.clear();
        this.store.revokeUrls();

        await this.store.deletePack(this.currentPackId);

        const packs = await this.store.getAllPacks();
        if (packs.length > 0) {
            await this.loadPack(packs[0].id);
        } else {
            this.currentPack = null;
            this.currentPackId = null;
            this.sounds = [];
            this.scenes = [];
            this.activeSceneId = null;
            this.editingSceneId = null;
            this.invalidateFlatSoundsCache();
            localStorage.removeItem('soundTapApp');
            this.renderScenes();
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

                // Check for library-based pack (v2 export)
                const hasLibraryData = data.library && Array.isArray(data.library);
                const hasAudioIds = this._checkHasAudioIds(data.sounds);

                let sounds;
                if (hasLibraryData) {
                    // v2 format — import library entries
                    for (const track of data.library) {
                        const existing = await this.store.getLibraryTrack(track.id);
                        if (!existing) {
                            await this.store.saveLibraryTrack(track);
                            this._libraryMap.set(track.id, track);
                        }
                    }
                    sounds = data.sounds;
                } else if (hasAudioIds) {
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
                    scenes: Array.isArray(data.scenes) ? data.scenes : [],
                    createdAt: Date.now()
                });

                this.stopAllSounds();
                this._destroyAllAudioElements();
                this.playingAudios.clear();
                this.pausedAudios.clear();
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
            } else if (s.audioId || s.youtubeId) {
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
            } else if (entry.youtubeId) {
                result.push({
                    name: entry.name,
                    youtubeId: entry.youtubeId,
                    volume: entry.volume || 80,
                    loop: entry.loop || false
                });
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
        this._destroyAllAudioElements();
        this.playingAudios.clear();
        this.pausedAudios.clear();

        await this.loadPack(packId);

        this.searchQuery = '';
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = '';

        this.renderSounds();
        this.updateNowPlaying();
        await this.checkAudioFiles();
    }

    // ─── YouTube ──────────────────────────────────────────────────────────

    _parseYouTubeId(url) {
        if (!url) return null;
        const patterns = [
            /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
            /^([a-zA-Z0-9_-]{11})$/
        ];
        for (const p of patterns) {
            const match = url.match(p);
            if (match) return match[1];
        }
        return null;
    }

    _ensureYouTubeAPI() {
        if (this._ytApiReady) return this._ytApiReady;
        if (window.YT && window.YT.Player) return Promise.resolve();

        this._ytApiReady = new Promise((resolve) => {
            const existingCallback = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => {
                if (existingCallback) existingCallback();
                resolve();
            };
            const script = document.createElement('script');
            script.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(script);
        });
        return this._ytApiReady;
    }

    _createYouTubePlayer(videoId) {
        return new Promise((resolve) => {
            let container = document.getElementById('youtube-players');
            if (!container) {
                container = document.createElement('div');
                container.id = 'youtube-players';
                container.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
                document.body.appendChild(container);
            }

            const el = document.createElement('div');
            el.id = `yt-player-${++this._ytPlayerCounter}`;
            container.appendChild(el);

            const adapter = new YouTubeAudioAdapter(null);
            const player = new YT.Player(el.id, {
                videoId,
                playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, modestbranding: 1 },
                events: {
                    onReady: () => {
                        adapter.player = player;
                        adapter._ready = true;
                        if (adapter._onLoadedMetadata) adapter._onLoadedMetadata();
                        resolve(adapter);
                    },
                    onStateChange: (e) => adapter._handleStateChange(e.data),
                    onError: (e) => {
                        if (adapter._onError) adapter._onError(e);
                    }
                }
            });
            adapter.player = player;
        });
    }

    async _fetchYouTubeTitle(videoId) {
        try {
            const resp = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
            if (!resp.ok) return null;
            const data = await resp.json();
            return data.title || null;
        } catch { return null; }
    }

    async addYouTubeToTop() {
        const url = prompt('YouTube URL:');
        if (!url || !url.trim()) return;

        const videoId = this._parseYouTubeId(url.trim());
        if (!videoId) {
            this.showNotification('Invalid YouTube URL', 'error');
            return;
        }

        this.showNotification('Fetching video info...', 'info');
        const title = await this._fetchYouTubeTitle(videoId) || videoId;
        const name = prompt('Sound name:', title) || title;

        const libraryId = crypto.randomUUID();
        const track = { id: libraryId, name: name.trim(), youtubeId: videoId, createdAt: Date.now() };
        await this.store.saveLibraryTrack(track);
        this._libraryMap.set(libraryId, track);
        this.sounds.push({ libraryId, volume: 80, loop: false });
        this.invalidateFlatSoundsCache();
        await this.savePack();
        this.renderSounds();
        this.restorePlayingStates();
        this.filterSounds();
        this.showNotification(`Added YouTube sound "${name.trim()}"`, 'info');
    }

    async addYouTubeToGroup(groupIndex) {
        const group = this.sounds[groupIndex];
        if (!group || !group.sounds) return;

        const url = prompt('YouTube URL:');
        if (!url || !url.trim()) return;

        const videoId = this._parseYouTubeId(url.trim());
        if (!videoId) {
            this.showNotification('Invalid YouTube URL', 'error');
            return;
        }

        this.showNotification('Fetching video info...', 'info');
        const title = await this._fetchYouTubeTitle(videoId) || videoId;
        const name = prompt('Sound name:', title) || title;

        const libraryId = crypto.randomUUID();
        const track = { id: libraryId, name: name.trim(), youtubeId: videoId, createdAt: Date.now() };
        await this.store.saveLibraryTrack(track);
        this._libraryMap.set(libraryId, track);
        group.sounds.push({ libraryId, volume: 80, loop: false });
        this.invalidateFlatSoundsCache();
        await this.savePack();
        this.renderSounds();
        this.restorePlayingStates();
        this.filterSounds();
        this.showNotification(`Added YouTube sound "${name.trim()}"`, 'info');
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

        // Delete associated audio/library entries
        if (group.sounds) {
            const allPacks = await this.store.getAllPacks();
            const otherSounds = this.sounds.filter((_, i) => i !== groupIndex);
            const otherLibIds = new Set(this.store._collectLibraryIds(otherSounds));
            const otherPackLibIds = new Set();
            allPacks.forEach(p => {
                if (p.id !== this.currentPackId) {
                    this.store._collectLibraryIds(p.sounds || []).forEach(id => otherPackLibIds.add(id));
                }
            });
            for (const sound of group.sounds) {
                if (sound.libraryId && !otherLibIds.has(sound.libraryId) && !otherPackLibIds.has(sound.libraryId)) {
                    const track = this._libraryMap.get(sound.libraryId);
                    if (track && track.audioId) await this.store.deleteAudio(track.audioId);
                    await this.store.deleteLibraryTrack(sound.libraryId);
                    this._libraryMap.delete(sound.libraryId);
                }
            }
        }

        this.sounds.splice(groupIndex, 1);
        this.invalidateFlatSoundsCache();

        // Clear audio elements and playing state since indices shifted
        this.stopAllSounds();
        this._destroyAllAudioElements();
        this.playingAudios.clear();
        this.pausedAudios.clear();

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
            const libraryId = crypto.randomUUID();
            const track = { id: libraryId, name, audioId, createdAt: Date.now() };
            await this.store.saveLibraryTrack(track);
            this._libraryMap.set(libraryId, track);
            group.sounds.push({ libraryId, volume: 80, loop: false });
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
            const libraryId = crypto.randomUUID();
            const track = { id: libraryId, name, audioId, createdAt: Date.now() };
            await this.store.saveLibraryTrack(track);
            this._libraryMap.set(libraryId, track);
            this.sounds.push({ libraryId, volume: 80, loop: false });
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

        if (sound.libraryId) {
            const track = await this.store.getLibraryTrack(sound.libraryId);
            if (track) {
                track.name = name.trim();
                await this.store.saveLibraryTrack(track);
                this._libraryMap.set(track.id, track);
            }
        }
        sound.name = name.trim();

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

        if (sound.libraryId) {
            // Check if any other pack or other position in this pack references this libraryId
            const allPacks = await this.store.getAllPacks();
            const otherPackRefs = allPacks.some(p =>
                p.id !== this.currentPackId &&
                this.store._collectLibraryIds(p.sounds || []).includes(sound.libraryId)
            );
            const thisPackRefs = this.store._collectLibraryIds(this.sounds);
            const thisPackCount = thisPackRefs.filter(id => id === sound.libraryId).length;
            if (!otherPackRefs && thisPackCount <= 1) {
                const track = this._libraryMap.get(sound.libraryId);
                if (track && track.audioId) await this.store.deleteAudio(track.audioId);
                await this.store.deleteLibraryTrack(sound.libraryId);
                this._libraryMap.delete(sound.libraryId);
            }
        }

        this._removeSoundByFlatIndex(flatIndex);
        this.invalidateFlatSoundsCache();

        // Clear state since indices shifted
        this.stopAllSounds();
        this._destroyAllAudioElements();
        this.playingAudios.clear();
        this.pausedAudios.clear();

        await this.savePack();
        this.renderSounds();
    }

    _locateSoundByFlatIndex(flatIndex) {
        let currentIndex = 0;
        for (let i = 0; i < this.sounds.length; i++) {
            const entry = this.sounds[i];
            if (entry.sounds && Array.isArray(entry.sounds)) {
                for (let j = 0; j < entry.sounds.length; j++) {
                    if (currentIndex === flatIndex) return { list: entry.sounds, index: j, groupIndex: i };
                    currentIndex++;
                }
            } else {
                if (currentIndex === flatIndex) return { list: this.sounds, index: i, groupIndex: null };
                currentIndex++;
            }
        }
        return null;
    }

    /* targetGroup is a group object from this.sounds, or null for top level.
       It is passed by reference rather than by index because splicing the
       source out of this.sounds can shift every later group's index. */
    async moveSoundToGroup(flatIndex, targetGroup) {
        const loc = this._locateSoundByFlatIndex(flatIndex);
        if (!loc) return;
        const targetList = targetGroup ? targetGroup.sounds : this.sounds;
        if (loc.list === targetList) return;

        const name = this.getFlatSounds()[flatIndex]?.name || 'Sound';

        // Session membership is stored as flat indices, which the move shifts
        const rawBefore = this.getRawFlatSounds();
        const sessionSounds = [...this.sessionTracks].map(i => rawBefore[i]).filter(Boolean);

        const [entry] = loc.list.splice(loc.index, 1);
        targetList.push(entry);
        this.invalidateFlatSoundsCache();

        const rawAfter = this.getRawFlatSounds();
        this.sessionTracks = new Set(
            sessionSounds.map(s => rawAfter.indexOf(s)).filter(i => i !== -1)
        );
        this.saveSessionToStorage();

        // Indices shifted, so drop playback state the way deleteSound does
        this.stopAllSounds();
        this._destroyAllAudioElements();
        this.playingAudios.clear();
        this.pausedAudios.clear();

        await this.savePack();
        this.renderSounds();
        this.filterSounds();
        this.showNotification(
            `Moved "${name}" to ${targetGroup ? `"${targetGroup.name}"` : 'no group'}`, 'info');
    }

    async moveSoundToNewGroup(flatIndex) {
        const name = prompt('New group name:');
        if (!name || !name.trim()) return;
        const group = { name: name.trim(), sounds: [] };
        this.sounds.push(group);
        await this.moveSoundToGroup(flatIndex, group);
    }

    _openMoveMenu(anchorBtn, flatIndex) {
        this._closeMoveMenu();

        const loc = this._locateSoundByFlatIndex(flatIndex);
        if (!loc) return;

        const menu = document.createElement('div');
        menu.className = 'tile-move-menu';

        const addItem = (label, isCurrent, onPick) => {
            const btn = document.createElement('button');
            btn.className = 'tile-move-item';
            btn.textContent = label;
            if (isCurrent) {
                btn.classList.add('current');
                btn.disabled = true;
            } else {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._closeMoveMenu();
                    onPick();
                });
            }
            menu.appendChild(btn);
        };

        addItem('No group', loc.groupIndex === null, () => this.moveSoundToGroup(flatIndex, null));
        this.sounds.forEach((entry, i) => {
            if (!entry.sounds || !Array.isArray(entry.sounds)) return;
            addItem(entry.name, loc.groupIndex === i, () => this.moveSoundToGroup(flatIndex, entry));
        });
        addItem('+ New group…', false, () => this.moveSoundToNewGroup(flatIndex));

        // Appended to the body: .sound-tile has overflow:hidden and would clip it
        document.body.appendChild(menu);
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;

        this._moveMenu = menu;
        this._moveMenuDismiss = (e) => { if (!menu.contains(e.target)) this._closeMoveMenu(); };
        this._moveMenuKeydown = (e) => { if (e.key === 'Escape') this._closeMoveMenu(); };
        this._moveMenuReposition = () => this._closeMoveMenu();
        // Deferred, or the click that opened the menu would dismiss it at once
        setTimeout(() => {
            if (!this._moveMenu) return;
            document.addEventListener('click', this._moveMenuDismiss);
            document.addEventListener('keydown', this._moveMenuKeydown);
            window.addEventListener('scroll', this._moveMenuReposition, true);
            window.addEventListener('resize', this._moveMenuReposition);
        }, 0);
    }

    _closeMoveMenu() {
        if (!this._moveMenu) return;
        this._moveMenu.remove();
        this._moveMenu = null;
        document.removeEventListener('click', this._moveMenuDismiss);
        document.removeEventListener('keydown', this._moveMenuKeydown);
        window.removeEventListener('scroll', this._moveMenuReposition, true);
        window.removeEventListener('resize', this._moveMenuReposition);
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

    // ─── Library View ─────────────────────────────────────────────────

    async openLibraryModal() {
        const modal = document.getElementById('library-modal');
        if (!modal) return;
        modal.style.display = 'flex';

        const searchInput = document.getElementById('library-search-input');
        if (searchInput) { searchInput.value = ''; }

        await this.renderLibraryTracks();

        if (searchInput) searchInput.focus();
    }

    closeLibraryModal() {
        const modal = document.getElementById('library-modal');
        if (modal) modal.style.display = 'none';
    }

    async renderLibraryTracks(filter = '') {
        const list = document.getElementById('library-track-list');
        const countEl = document.getElementById('library-track-count');
        if (!list) return;

        const allTracks = await this.store.getAllLibraryTracks();
        const allPacks = await this.store.getAllPacks();

        // Build reference count per libraryId
        const refCounts = new Map();
        for (const pack of allPacks) {
            const libIds = this.store._collectLibraryIds(pack.sounds || []);
            for (const id of libIds) {
                refCounts.set(id, (refCounts.get(id) || 0) + 1);
            }
        }

        // Track which libraryIds are in the current pack
        const currentPackIds = new Set(this.store._collectLibraryIds(this.sounds));

        const query = filter.toLowerCase().trim();
        const filtered = query
            ? allTracks.filter(t => t.name.toLowerCase().includes(query))
            : allTracks;

        // Sort alphabetically
        filtered.sort((a, b) => a.name.localeCompare(b.name));

        list.innerHTML = '';

        if (filtered.length === 0) {
            list.innerHTML = `<div class="library-empty">${query ? 'No matching tracks' : 'Library is empty'}</div>`;
        } else {
            for (const track of filtered) {
                const refs = refCounts.get(track.id) || 0;
                const isYt = !!track.youtubeId;
                const inCurrentPack = currentPackIds.has(track.id);
                const item = document.createElement('div');
                item.className = 'library-track-item';
                item.dataset.trackId = track.id;

                item.innerHTML = `
                    <span class="library-track-type ${isYt ? 'library-track-type-yt' : 'library-track-type-file'}">${isYt ? 'YT' : 'File'}</span>
                    <span class="library-track-name" title="${this._escapeHtml(track.name)}">${this._escapeHtml(track.name)}</span>
                    <span class="library-track-refs">${refs} pack${refs !== 1 ? 's' : ''}</span>
                    <div class="library-track-actions">
                        <button class="library-track-action-btn library-add-to-pack-btn" title="${inCurrentPack ? 'Already in pack' : 'Add to current pack'}" ${inCurrentPack ? 'disabled style="opacity:0.3;cursor:not-allowed"' : ''}>+</button>
                        <button class="library-track-action-btn library-rename-btn" title="Rename">✏</button>
                        <button class="library-track-action-btn library-delete-btn" title="Delete${refs > 0 ? ' (used in packs)' : ''}" ${refs > 0 ? 'disabled style="opacity:0.3;cursor:not-allowed"' : ''}>×</button>
                    </div>
                `;

                if (!inCurrentPack) {
                    item.querySelector('.library-add-to-pack-btn').addEventListener('click', () => this.addLibraryTrackToPack(track.id));
                }
                item.querySelector('.library-rename-btn').addEventListener('click', () => this.renameLibraryTrack(track.id));
                if (refs === 0) {
                    item.querySelector('.library-delete-btn').addEventListener('click', () => this.deleteLibraryTrack(track.id));
                }

                list.appendChild(item);
            }
        }

        if (countEl) {
            countEl.textContent = `${filtered.length} track${filtered.length !== 1 ? 's' : ''}${query ? ` matching "${filter}"` : ' in library'}`;
        }
    }

    filterLibraryTracks(query) {
        this.renderLibraryTracks(query);
    }

    async addLibraryTrackToPack(trackId) {
        if (!this.currentPack) return;

        this.sounds.push({ libraryId: trackId, volume: 80, loop: false });
        this.invalidateFlatSoundsCache();
        await this.savePack();
        this.renderSounds();
        this.restorePlayingStates();
        this.filterSounds();

        const track = this._libraryMap.get(trackId);
        this.showNotification(`Added "${track?.name || 'track'}" to pack`, 'info');

        // Re-render modal to update the button state
        const searchInput = document.getElementById('library-search-input');
        await this.renderLibraryTracks(searchInput?.value || '');
    }

    async renameLibraryTrack(trackId) {
        const track = await this.store.getLibraryTrack(trackId);
        if (!track) return;

        const name = prompt('Rename track:', track.name);
        if (!name || !name.trim() || name.trim() === track.name) return;

        track.name = name.trim();
        await this.store.saveLibraryTrack(track);
        this._libraryMap.set(track.id, track);

        // Re-render library modal
        const searchInput = document.getElementById('library-search-input');
        await this.renderLibraryTracks(searchInput?.value || '');

        // Re-render sounds if the track is in current pack
        this.invalidateFlatSoundsCache();
        this.renderSounds();
        this.restorePlayingStates();
        this.updateNowPlaying();
    }

    async deleteLibraryTrack(trackId) {
        const track = await this.store.getLibraryTrack(trackId);
        if (!track) return;
        if (!confirm(`Delete "${track.name}" from the library?`)) return;

        if (track.audioId) await this.store.deleteAudio(track.audioId);
        await this.store.deleteLibraryTrack(trackId);
        this._libraryMap.delete(trackId);

        const searchInput = document.getElementById('library-search-input');
        await this.renderLibraryTracks(searchInput?.value || '');
    }

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ─── Full Backup / Restore ─────────────────────────────────────────

    _writeUint32(value) {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint32(0, value, true);
        return buf;
    }

    async _readSlice(file, offset, length) {
        return file.slice(offset, offset + length).arrayBuffer();
    }

    _readUint32(buffer) {
        return new DataView(buffer).getUint32(0, true);
    }

    async fullBackup() {
        try {
            const allPacks = await this.store.getAllPacks();
            const allLibrary = await this.store.getAllLibraryTracks();

            const audioIds = [];
            for (const track of allLibrary) {
                if (track.audioId) audioIds.push(track.audioId);
            }

            const encoder = new TextEncoder();
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');

            // Try File System Access API for true streaming (no memory buildup)
            if (window.showSaveFilePicker) {
                await this._fullBackupStreaming(allPacks, allLibrary, audioIds, encoder, timestamp);
            } else {
                await this._fullBackupFallback(allPacks, allLibrary, audioIds, encoder, timestamp);
            }
        } catch (error) {
            if (error.name === 'AbortError') return; // user cancelled file picker
            console.error('Backup failed:', error);
            this.showNotification('Backup failed: ' + error.message, 'error');
        }
    }

    async _fullBackupStreaming(allPacks, allLibrary, audioIds, encoder, timestamp) {
        const fileHandle = await window.showSaveFilePicker({
            suggestedName: `sound-tap-backup-${timestamp}.stbackup`,
            types: [{ description: 'Sound Tap Backup', accept: { 'application/octet-stream': ['.stbackup'] } }]
        });
        const writable = await fileHandle.createWritable();
        let totalBytes = 0;

        const write = async (data) => {
            await writable.write(data);
            if (data.size !== undefined) totalBytes += data.size;
            else if (data.byteLength !== undefined) totalBytes += data.byteLength;
        };

        // Magic + version
        await write(new Uint8Array([0x53, 0x54, 0x42, 0x4B]));
        await write(new Uint8Array(this._writeUint32(2)));

        // Metadata
        const metaJson = encoder.encode(JSON.stringify({ packs: allPacks, library: allLibrary }));
        await write(new Uint8Array(this._writeUint32(metaJson.byteLength)));
        await write(metaJson);

        // Audio count
        await write(new Uint8Array(this._writeUint32(audioIds.length)));

        let audioCount = 0;
        const toast = this.createPersistentNotification(`Writing audio 0/${audioIds.length}...`);
        for (const audioId of audioIds) {
            const record = await this.store.getAudioRecord(audioId);
            if (!record || !record.blob) {
                await write(new Uint8Array(this._writeUint32(0)));
                await write(new Uint8Array(this._writeUint32(0)));
                continue;
            }
            const headerJson = encoder.encode(JSON.stringify({
                id: record.id, name: record.name, mimeType: record.mimeType,
                size: record.size, createdAt: record.createdAt
            }));
            await write(new Uint8Array(this._writeUint32(headerJson.byteLength)));
            await write(headerJson);
            await write(new Uint8Array(this._writeUint32(record.blob.size)));
            await write(record.blob); // streamed directly to disk
            audioCount++;
            toast.update(`Writing audio ${audioCount}/${audioIds.length}...`);
        }
        toast.dismiss();

        await writable.close();
        const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
        this.showNotification(`Backup exported (${sizeMB} MB, ${allPacks.length} packs, ${audioCount} audio files)`, 'info');
    }

    async _fullBackupFallback(allPacks, allLibrary, audioIds, encoder, timestamp) {
        // Fallback: build blob from parts array (blobs are references, not copies)
        const parts = [];

        parts.push(new Uint8Array([0x53, 0x54, 0x42, 0x4B]));
        parts.push(this._writeUint32(2));

        const metaJson = encoder.encode(JSON.stringify({ packs: allPacks, library: allLibrary }));
        parts.push(this._writeUint32(metaJson.byteLength));
        parts.push(metaJson);

        parts.push(this._writeUint32(audioIds.length));
        let audioCount = 0;
        const toast = this.createPersistentNotification(`Preparing audio 0/${audioIds.length}...`);
        for (const audioId of audioIds) {
            const record = await this.store.getAudioRecord(audioId);
            if (!record || !record.blob) {
                parts.push(this._writeUint32(0));
                parts.push(this._writeUint32(0));
                continue;
            }
            const headerJson = encoder.encode(JSON.stringify({
                id: record.id, name: record.name, mimeType: record.mimeType,
                size: record.size, createdAt: record.createdAt
            }));
            parts.push(this._writeUint32(headerJson.byteLength));
            parts.push(headerJson);
            parts.push(this._writeUint32(record.blob.size));
            parts.push(record.blob);
            audioCount++;
            toast.update(`Preparing audio ${audioCount}/${audioIds.length}...`);
        }
        toast.dismiss();

        const backupBlob = new Blob(parts, { type: 'application/octet-stream' });
        parts.length = 0;

        const url = URL.createObjectURL(backupBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `sound-tap-backup-${timestamp}.stbackup`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        const sizeMB = (backupBlob.size / (1024 * 1024)).toFixed(1);
        this.showNotification(`Backup exported (${sizeMB} MB, ${allPacks.length} packs, ${audioCount} audio files)`, 'info');
    }

    async restoreBackup() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.stbackup';
        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                let offset = 0;

                // Read magic
                const magic = new Uint8Array(await this._readSlice(file, offset, 4));
                offset += 4;
                if (String.fromCharCode(...magic) !== 'STBK') {
                    this.showNotification('Not a valid Sound Tap backup file', 'error');
                    return;
                }

                // Read version
                offset += 4; // skip version for now

                // Read metadata
                const metaLen = this._readUint32(await this._readSlice(file, offset, 4));
                offset += 4;
                const metaBuf = await this._readSlice(file, offset, metaLen);
                const metadata = JSON.parse(new TextDecoder().decode(metaBuf));
                offset += metaLen;

                // Read audio count
                const audioCount = this._readUint32(await this._readSlice(file, offset, 4));
                offset += 4;

                const packCount = (metadata.packs || []).length;
                const libCount = (metadata.library || []).length;
                if (!confirm(`Restore backup?\n\n${packCount} pack(s), ${libCount} library track(s), ${audioCount} audio file(s).\n\nExisting data with the same IDs will be overwritten.`)) return;

                const toast = this.createPersistentNotification(`Restoring audio 0/${audioCount}...`);

                // Restore audio — read one at a time, no full file in memory
                for (let i = 0; i < audioCount; i++) {
                    const hLen = this._readUint32(await this._readSlice(file, offset, 4));
                    offset += 4;
                    if (hLen === 0) { offset += 4; continue; } // skip empty
                    const hBuf = await this._readSlice(file, offset, hLen);
                    const entryHeader = JSON.parse(new TextDecoder().decode(hBuf));
                    offset += hLen;

                    const blobLen = this._readUint32(await this._readSlice(file, offset, 4));
                    offset += 4;
                    // Read bytes into memory and create a standalone Blob
                    // (file.slice returns a lazy reference that may not survive in IndexedDB)
                    const blobData = await this._readSlice(file, offset, blobLen);
                    const blob = new Blob([blobData], { type: entryHeader.mimeType || 'audio/mpeg' });
                    offset += blobLen;

                    const audioRecord = {
                        id: entryHeader.id, name: entryHeader.name,
                        mimeType: entryHeader.mimeType, blob,
                        size: entryHeader.size, createdAt: entryHeader.createdAt
                    };
                    const store = this.store._tx('audio', 'readwrite');
                    await this.store._request(store, 'put', audioRecord);
                    toast.update(`Restoring audio ${i + 1}/${audioCount}...`);
                }
                toast.dismiss();

                // Restore library
                for (const track of (metadata.library || [])) {
                    await this.store.saveLibraryTrack(track);
                }

                // Restore packs
                for (const pack of (metadata.packs || [])) {
                    await this.store.savePack(pack);
                }

                // Reload
                this.stopAllSounds();
                this._destroyAllAudioElements();
                this.playingAudios.clear();
                this.pausedAudios.clear();
                await this._loadLibraryMap();
                await this.loadPackList();
                const packs = await this.store.getAllPacks();
                if (packs.length > 0) {
                    await this.loadPack(packs[0].id);
                }
                this.renderSounds();
                await this.checkAudioFiles();
                this.showNotification(`Restored! (${packCount} packs, ${audioCount} audio files)`, 'info');
            } catch (err) {
                console.error('Restore failed:', err);
                this.showNotification('Restore failed: ' + err.message, 'error');
            }
        });
        input.click();
    }

    async clearStorage() {
        if (!confirm('Delete all IndexedDB data and reload?\n\nThis will remove all packs and audio. This cannot be undone.')) return;
        localStorage.clear();
        // Close the DB connection first, then wait for delete to complete before reloading
        this.store.db.close();
        await new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase('SoundTapDB');
            req.onsuccess = resolve;
            req.onerror = reject;
            req.onblocked = resolve;
        });
        window.location.reload();
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
                sounds: this._exportSounds(this.sounds),
                scenes: this.scenes
            };
            const libraryIds = new Set(this.store._collectLibraryIds(this.sounds));
            exportData.library = [...libraryIds].map(id => this._libraryMap.get(id)).filter(Boolean);
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
            if (s.libraryId) {
                return { libraryId: s.libraryId, volume: s.volume, loop: s.loop };
            }
            return { name: s.name, volume: s.volume, loop: s.loop };
        });
    }

    restorePlayingStates() {
        this.playingAudios.forEach(index => this.updateSoundControls(index, 'playing'));
        this.pausedAudios.forEach(index => {
            this.updateSoundControls(index, 'paused');
            this.updateSoundStatus(index, 'Paused');
        });
        this.updateNowPlaying();
    }

    // ─── Scenes ──────────────────────────────────────────────────────────

    get sceneFadeMs() { return 2500; }

    setupSceneControls() {
        const addBtn = document.getElementById('scene-add-btn');
        const playBtn = document.getElementById('scene-lit-play');
        const fadeBtn = document.getElementById('scene-lit-fade');
        if (addBtn) addBtn.addEventListener('click', () => this.createScene());
        if (playBtn) playBtn.addEventListener('click', () => this.playLitScene(true));
        if (fadeBtn) fadeBtn.addEventListener('click', () => this.playLitScene(false));
    }

    /* The lit scenes are the queue. The top one is what the Play and Fade
       buttons above the list act on; launching it puts its flame out, which
       promotes the next lit scene into its place. */
    getLitScene() {
        return this.scenes.find(s => s.lit) || null;
    }

    getEditingScene() {
        return this.scenes.find(s => s.id === this.editingSceneId) || null;
    }

    playLitScene(hard) {
        const scene = this.getLitScene();
        if (scene) this.playScene(scene, hard);
    }

    renderScenes() {
        const panel = document.getElementById('scene-panel');
        const list = document.getElementById('scene-list');
        const litActions = document.getElementById('scene-lit-actions');
        if (!panel || !list) return;

        panel.style.display = this.currentPack ? 'flex' : 'none';
        if (litActions) litActions.style.display = this.getLitScene() ? 'flex' : 'none';

        list.innerHTML = '';

        if (this.scenes.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'scene-empty';
            empty.textContent = 'Press + for a new scene, then click it and add tracks with the + on each tile.';
            list.appendChild(empty);
            return;
        }

        // Lit scenes ride on top. Array.prototype.sort is stable, so everything
        // else keeps the order it was created in.
        const ordered = [...this.scenes].sort((a, b) => (b.lit ? 1 : 0) - (a.lit ? 1 : 0));
        ordered.forEach(scene => {
            list.appendChild(this._createScenePill(scene));
            // the selected scene opens up to show what is in it
            if (scene.id === this.editingSceneId) {
                list.appendChild(this._createSceneTrackList(scene));
            }
        });
    }

    _createScenePill(scene) {
        const trackCount = (scene.tracks || []).length;

        const pill = document.createElement('div');
        pill.className = 'scene-pill';
        if (scene.lit) pill.classList.add('lit');
        if (scene.id === this.activeSceneId) pill.classList.add('active');
        if (scene.id === this.editingSceneId) pill.classList.add('editing');

        const flame = document.createElement('button');
        flame.className = 'scene-flame';
        flame.textContent = '🔥';
        flame.title = scene.lit
            ? 'Put this scene out'
            : 'Light this scene to queue it up top';

        flame.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleSceneLit(scene.id);
        });

        const name = document.createElement('button');
        name.className = 'scene-name';
        name.textContent = scene.name;
        name.title = `${scene.name} — ${trackCount} track(s). Click to pick tracks for it.`
            + (scene.lit ? ' Drag to reorder the queue.' : '');
        name.addEventListener('click', () => this.selectScene(scene.id));

        pill.append(flame, name);

        if (scene.lit) this._makeSceneDraggable(pill, scene);

        // A lit scene is launched from the buttons above the list, so it does
        // not carry its own. An empty scene has nothing to launch yet.
        if (!scene.lit && trackCount > 0) {
            const play = document.createElement('button');
            play.className = 'scene-pill-btn scene-pill-play';
            play.textContent = '▶';
            play.title = `Stop everything and start "${scene.name}" now`;
            play.addEventListener('click', (e) => {
                e.stopPropagation();
                this.playScene(scene, true);
            });

            const fade = document.createElement('button');
            fade.className = 'scene-pill-btn scene-pill-fade';
            fade.textContent = '⇄';
            fade.title = `Crossfade into "${scene.name}"`;
            fade.addEventListener('click', (e) => {
                e.stopPropagation();
                this.playScene(scene, false);
            });

            pill.append(play, fade);
        }

        const del = document.createElement('button');
        del.className = 'scene-delete';
        del.textContent = '×';
        del.title = 'Delete scene';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteScene(scene.id);
        });
        pill.append(del);

        return pill;
    }

    // ─── Reordering the lit queue ────────────────────────────────────────

    _makeSceneDraggable(pill, scene) {
        pill.draggable = true;
        pill.dataset.sceneId = scene.id;

        pill.addEventListener('dragstart', (e) => {
            this._dragSceneId = scene.id;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', scene.id);
            pill.classList.add('dragging');
        });

        pill.addEventListener('dragend', () => {
            this._dragSceneId = null;
            pill.classList.remove('dragging');
            this._clearDropMarkers();
        });

        pill.addEventListener('dragover', (e) => {
            const dragged = this._dragSceneId;
            if (!dragged || dragged === scene.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = pill.getBoundingClientRect();
            const after = (e.clientY - rect.top) > rect.height / 2;
            this._clearDropMarkers();
            pill.classList.add(after ? 'drop-after' : 'drop-before');
        });

        pill.addEventListener('dragleave', () => {
            pill.classList.remove('drop-before', 'drop-after');
        });

        pill.addEventListener('drop', (e) => {
            e.preventDefault();
            const dragged = this._dragSceneId || e.dataTransfer.getData('text/plain');
            const after = pill.classList.contains('drop-after');
            this._clearDropMarkers();
            if (dragged && dragged !== scene.id) {
                this.moveLitScene(dragged, scene.id, after);
            }
        });
    }

    _clearDropMarkers() {
        document.querySelectorAll('.scene-pill.drop-before, .scene-pill.drop-after')
            .forEach(el => el.classList.remove('drop-before', 'drop-after'));
    }

    /* Lit scenes are shown first by a stable sort, so their play order is just
       their relative order inside this.scenes. Reordering therefore rewrites
       only the slots the lit scenes already occupy, leaving the unlit ones
       exactly where they are. */
    async moveLitScene(draggedId, targetId, after) {
        const litIds = this.scenes.filter(s => s.lit).map(s => s.id);
        const reordered = litIds.filter(id => id !== draggedId);

        let at = reordered.indexOf(targetId);
        if (at === -1) return;
        if (after) at += 1;
        reordered.splice(at, 0, draggedId);

        const slots = [];
        this.scenes.forEach((s, i) => { if (s.lit) slots.push(i); });
        const byId = new Map(this.scenes.map(s => [s.id, s]));
        reordered.forEach((id, k) => { this.scenes[slots[k]] = byId.get(id); });

        await this.savePack();
        this.renderScenes();
    }

    _createSceneTrackList(scene) {
        const wrap = document.createElement('div');
        wrap.className = 'scene-tracks';

        const refs = scene.tracks || [];
        if (refs.length === 0) {
            const hint = document.createElement('p');
            hint.className = 'scene-tracks-empty';
            hint.textContent = 'No tracks yet — add them with the + on a tile.';
            wrap.appendChild(hint);
            return wrap;
        }

        const flat = this.getFlatSounds();
        refs.forEach((ref, i) => {
            const index = this._resolveSceneTrack(ref);
            const label = index === -1 ? (ref.name || 'Unknown track') : flat[index].name;

            const row = document.createElement('div');
            row.className = 'scene-track';
            if (index === -1) row.classList.add('missing');

            const name = document.createElement('span');
            name.className = 'scene-track-name';
            name.textContent = label;
            name.title = index === -1 ? `${label} — no longer in this pack` : label;

            const remove = document.createElement('button');
            remove.className = 'scene-track-remove';
            remove.textContent = '×';
            remove.title = `Remove "${label}" from this scene`;
            remove.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeSceneTrack(scene.id, i);
            });

            row.append(name, remove);
            wrap.appendChild(row);
        });

        return wrap;
    }

    /* Removes by position in scene.tracks rather than by resolved index, so
       that refs which no longer match anything in the pack can be cleared. */
    async removeSceneTrack(sceneId, trackIndex) {
        const scene = this.scenes.find(s => s.id === sceneId);
        if (!scene || !scene.tracks) return;
        scene.tracks.splice(trackIndex, 1);
        await this.savePack();
        this.renderScenes();
        this.updateSceneTileButtons();
    }

    async toggleSceneLit(sceneId) {
        const scene = this.scenes.find(s => s.id === sceneId);
        if (!scene) return;
        scene.lit = !scene.lit;
        await this.savePack();
        this.renderScenes();
    }

    async createScene() {
        const name = prompt('Scene name:');
        if (!name || !name.trim()) return;

        const scene = {
            id: `scene-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: name.trim(),
            lit: false,
            tracks: []
        };
        this.scenes.push(scene);

        // Deliberately not selected here: selecting is the click on the pill,
        // and auto-selecting would make that click toggle the scene back off.
        await this.savePack();
        this.renderScenes();
        this.showNotification(`Scene "${scene.name}" created — click it, then add tracks with the + on each tile`, 'info');
    }

    selectScene(sceneId) {
        this.editingSceneId = this.editingSceneId === sceneId ? null : sceneId;
        this.renderScenes();
        this.updateSceneTileButtons();
    }

    async deleteScene(sceneId) {
        const scene = this.scenes.find(s => s.id === sceneId);
        if (!scene) return;
        if (!confirm(`Delete scene "${scene.name}"?`)) return;

        this.scenes = this.scenes.filter(s => s.id !== sceneId);
        if (this.activeSceneId === sceneId) this.activeSceneId = null;
        if (this.editingSceneId === sceneId) this.editingSceneId = null;

        await this.savePack();
        this.renderScenes();
        this.updateSceneTileButtons();
    }

    // ─── Picking tracks for a scene ──────────────────────────────────────

    async toggleTrackInScene(flatIndex) {
        const scene = this.getEditingScene();
        if (!scene) {
            this.showNotification('Click a scene first to choose where the track goes', 'error');
            return;
        }
        scene.tracks = scene.tracks || [];

        const existing = scene.tracks.findIndex(ref => this._resolveSceneTrack(ref) === flatIndex);
        if (existing !== -1) {
            scene.tracks.splice(existing, 1);
        } else {
            const ref = this._sceneTrackRef(flatIndex);
            if (!ref) return;
            scene.tracks.push(ref);
        }

        await this.savePack();
        this.renderScenes();
        this.updateSceneTileButtons();
    }

    _sceneTrackIndices(scene) {
        const indices = new Set();
        (scene.tracks || []).forEach(ref => {
            const index = this._resolveSceneTrack(ref);
            if (index !== -1) indices.add(index);
        });
        return indices;
    }

    /* The per-tile add button only exists while a scene is selected, so its
       visibility rides on a body class instead of a re-render of every tile. */
    updateSceneTileButtons() {
        const scene = this.getEditingScene();
        document.body.classList.toggle('scene-editing', !!scene);

        const inScene = scene ? this._sceneTrackIndices(scene) : new Set();
        document.querySelectorAll('.tile-scene-btn').forEach(btn => {
            const index = parseInt(btn.dataset.index, 10);
            const member = inScene.has(index);
            btn.classList.toggle('active', member);
            btn.textContent = member ? '✓' : '+';
            if (!scene) btn.title = 'Add to scene';
            else btn.title = member ? `Remove from "${scene.name}"` : `Add to "${scene.name}"`;
        });
    }

    _sceneTrackRef(flatIndex) {
        const sound = this.getFlatSounds()[flatIndex];
        if (!sound) return null;
        return {
            libraryId: sound.libraryId,
            audioId: sound.audioId,
            youtubeId: sound.youtubeId,
            name: sound.name,
            volume: sound.volume || 80,
            loop: !!sound.loop
        };
    }

    /* Scenes outlive edits to the pack, so a stored track is matched back by
       identity rather than by the flat index it happened to have when saved. */
    _resolveSceneTrack(ref) {
        const flat = this.getFlatSounds();
        let i = -1;
        if (ref.libraryId) i = flat.findIndex(s => s.libraryId === ref.libraryId);
        if (i === -1 && ref.audioId) i = flat.findIndex(s => s.audioId === ref.audioId);
        if (i === -1 && ref.youtubeId) i = flat.findIndex(s => s.youtubeId === ref.youtubeId);
        if (i === -1 && ref.name) i = flat.findIndex(s => s.name === ref.name);
        return i;
    }

    /* Starting a scene always replaces what is running: hard stops everything
       and starts instantly, otherwise the old tracks crossfade into the new. */
    async playScene(scene, hard = false) {
        const targets = [];
        const missing = [];
        (scene.tracks || []).forEach(ref => {
            const index = this._resolveSceneTrack(ref);
            if (index === -1) missing.push(ref.name || 'unknown');
            else targets.push({ index, ref });
        });

        if (targets.length === 0) {
            this.showNotification(`No track of scene "${scene.name}" is in this pack any more`, 'error');
            return;
        }

        const targetIndices = new Set(targets.map(t => t.index));

        if (hard) {
            // Everything stops, then the scene starts - shared tracks restart too
            this.stopAllSounds();
        } else {
            // Only what the scene does not need fades away
            [...new Set([...this.playingAudios, ...this.pausedAudios])]
                .filter(i => !targetIndices.has(i))
                .forEach(i => this._fadeTo(i, 0, this.sceneFadeMs, () => this.stopSound(i)));
        }

        // Lighting a scene marks it as up next; playing it puts the flame out
        // (set after stopAllSounds, which clears the active marker itself)
        if (scene.lit) scene.lit = false;
        this.activeSceneId = scene.id;

        for (const t of targets) {
            this._applySceneTrack(t);
            if (hard) {
                await this.playSound(t.index, false);
            } else if (this.playingAudios.has(t.index)) {
                // already running, so it just rides through the crossfade
                this._fadeTo(t.index, 1, this.sceneFadeMs);
            } else {
                this._setFadeGain(t.index, 0);
                await this.playSound(t.index, false, true);
                this._fadeTo(t.index, 1, this.sceneFadeMs);
            }
        }

        await this.savePack();
        this.renderScenes();
        if (missing.length > 0) {
            this.showNotification(`${missing.length} track(s) of "${scene.name}" are no longer in this pack`, 'error');
        }
    }

    _applySceneTrack({ index, ref }) {
        if (typeof ref.volume === 'number') this.setIndividualVolume(index, ref.volume);
        if (typeof ref.loop === 'boolean') this.toggleLoop(index, ref.loop);
    }

    // ─── Fading ──────────────────────────────────────────────────────────

    _setFadeGain(index, gain) {
        this.fadeGains.set(index, gain);
        this.updateAudioVolume(index);
    }

    _cancelFade(index) {
        const frame = this.fadeFrames.get(index);
        if (frame) cancelAnimationFrame(frame);
        this.fadeFrames.delete(index);
    }

    _fadeTo(index, target, ms, onDone) {
        this._cancelFade(index);
        const from = this.fadeGains.has(index) ? this.fadeGains.get(index) : 1;
        if (ms <= 0 || from === target) {
            this._setFadeGain(index, target);
            if (onDone) onDone();
            return;
        }

        const startedAt = performance.now();
        const step = () => {
            const progress = Math.min(1, (performance.now() - startedAt) / ms);
            this._setFadeGain(index, from + (target - from) * progress);
            if (progress < 1) {
                this.fadeFrames.set(index, requestAnimationFrame(step));
            } else {
                this.fadeFrames.delete(index);
                if (onDone) onDone();
            }
        };
        this.fadeFrames.set(index, requestAnimationFrame(step));
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

    // Returns a toast element that can be updated in place, then dismissed
    createPersistentNotification(message) {
        const notification = document.createElement('div');
        notification.className = 'notification notification-info';
        notification.textContent = message;
        const offset = this._notificationCount * 52;
        notification.style.top = `${20 + offset}px`;
        this._notificationCount++;
        document.body.appendChild(notification);
        return {
            update(msg) { notification.textContent = msg; },
            dismiss() {
                if (notification.parentNode) notification.parentNode.removeChild(notification);
                // no decrement needed — slot is freed
            }
        };
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new SoundTap();
});
