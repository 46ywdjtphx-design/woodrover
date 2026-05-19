/* ============================================================
   Rameur Woodrover · logique partagée
   ============================================================
   - Storage : entraînements en localStorage
   - BLE : driver FTMS pour Woodrover Domyos
   - Utils : formatage, génération d'IDs, toasts
   ============================================================ */

(function(global) {
  'use strict';

  // ============================================================
  // CONSTANTES BLE
  // ============================================================
  const BLE = {
    UUID: {
      FTMS_SERVICE:               '00001826-0000-1000-8000-00805f9b34fb',
      ROWER_DATA:                 '00002ad1-0000-1000-8000-00805f9b34fb',
      FITNESS_MACHINE_FEATURE:    '00002acc-0000-1000-8000-00805f9b34fb',
      FITNESS_MACHINE_STATUS:     '00002ada-0000-1000-8000-00805f9b34fb',
      CONTROL_POINT:              '00002ad9-0000-1000-8000-00805f9b34fb',
      TRAINING_STATUS:            '00002ad3-0000-1000-8000-00805f9b34fb',
      SUPPORTED_RESISTANCE_RANGE: '00002ad6-0000-1000-8000-00805f9b34fb',
      HRS_SERVICE:                '0000180d-0000-1000-8000-00805f9b34fb',
      HRM_CHARACTERISTIC:         '00002a37-0000-1000-8000-00805f9b34fb',
    },
    OP: {
      REQUEST_CONTROL:        0x00,
      RESET:                  0x01,
      SET_TARGET_RESISTANCE:  0x04,
      RESPONSE_CODE:          0x80,
    },
    RESULT: {
      0x01: 'Success',
      0x02: 'Op Code not supported',
      0x03: 'Invalid Parameter',
      0x04: 'Operation Failed',
      0x05: 'Control Not Permitted',
    },
    // Plage de niveaux UI : 1 à 15
    // Mapping vers raw uint8 : niveau N → 10*N (donc niv 1 = 10, niv 15 = 150)
    MIN_LEVEL: 1,
    MAX_LEVEL: 15,
    levelToRaw: function(level) {
      const l = Math.max(1, Math.min(15, Math.round(level)));
      return l * 10;
    },
    rawToLevel: function(raw) {
      return Math.max(1, Math.min(15, Math.round(raw / 10)));
    },
  };

  // ============================================================
  // UTILS
  // ============================================================
  const Utils = {
    /** Génère un ID unique (timestamp + random) */
    generateId: function() {
      return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    },

    /** Formate des secondes en mm:ss ou h:mm:ss */
    fmtTime: function(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
      seconds = Math.floor(seconds);
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      return m + ':' + String(s).padStart(2, '0');
    },

    /** Formate pace en m:ss/500m */
    fmtPace: function(speedKmh) {
      if (!speedKmh || speedKmh < 0.1) return '—';
      const secPer500 = (500 / (speedKmh * 1000 / 3600));
      const m = Math.floor(secPer500 / 60);
      const s = Math.floor(secPer500 % 60);
      return m + ':' + String(s).padStart(2, '0');
    },

    /** Parse une durée mm:ss ou h:mm:ss en secondes */
    parseTime: function(str) {
      if (!str) return 0;
      const parts = String(str).split(':').map(function(p){ return parseInt(p, 10) || 0; });
      if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
      if (parts.length === 2) return parts[0]*60 + parts[1];
      return parts[0] || 0;
    },

    bytesToHex: function(dv) {
      const arr = [];
      for (let i = 0; i < dv.byteLength; i++) arr.push(dv.getUint8(i).toString(16).padStart(2, '0'));
      return arr.join(' ');
    },

    describeError: function(e) {
      if (!e) return 'undefined';
      const parts = [];
      if (e.name) parts.push(e.name);
      if (e.message) parts.push(e.message);
      return parts.join(' — ') || String(e);
    },

    /** Détection rapide mobile */
    isMobile: function() {
      return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    },

    isIPhone: function() {
      return /iPhone|iPod/i.test(navigator.userAgent);
    },
  };

  // ============================================================
  // TOAST
  // ============================================================
  function toastHost() {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    return host;
  }

  const Toast = {
    show: function(msg, type, duration) {
      type = type || 'info';
      duration = duration || 3000;
      const host = toastHost();
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = msg;
      host.appendChild(el);
      setTimeout(function() {
        el.style.transition = 'opacity 0.3s';
        el.style.opacity = '0';
        setTimeout(function(){ el.remove(); }, 300);
      }, duration);
    },
    success: function(msg) { this.show(msg, 'success'); },
    error: function(msg) { this.show(msg, 'danger', 5000); },
    warning: function(msg) { this.show(msg, 'warning'); },
  };

  // ============================================================
  // STORAGE (localStorage) — Entraînements
  // ============================================================
  /**
   * Modèle de données :
   * {
   *   workouts: [
   *     {
   *       id: 'id_xxx',
   *       name: 'Pyramide 1',
   *       createdAt: 1234567890,
   *       updatedAt: 1234567890,
   *       blocks: [
   *         { id: 'id_yyy', duration: 60, level: 5 },  // 60s à niveau 5
   *         { id: 'id_zzz', duration: 120, level: 10 },
   *       ]
   *     }
   *   ]
   * }
   */
  const STORAGE_KEY = 'rameur_woodrover_v1';

  const Storage = {
    _load: function() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { workouts: [] };
        const data = JSON.parse(raw);
        if (!data.workouts) data.workouts = [];
        return data;
      } catch (e) {
        console.error('Storage load error', e);
        return { workouts: [] };
      }
    },

    _save: function(data) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (e) {
        console.error('Storage save error', e);
        Toast.error('Erreur de sauvegarde');
      }
    },

    getAll: function() {
      return this._load().workouts;
    },

    get: function(id) {
      return this._load().workouts.find(function(w){ return w.id === id; }) || null;
    },

    /** Crée un nouvel entraînement vide */
    create: function(name) {
      const data = this._load();
      const now = Date.now();
      const w = {
        id: Utils.generateId(),
        name: name || 'Nouvel entraînement',
        createdAt: now,
        updatedAt: now,
        blocks: [],
      };
      data.workouts.push(w);
      this._save(data);
      return w;
    },

    /** Sauvegarde un entraînement (création ou mise à jour) */
    save: function(workout) {
      const data = this._load();
      workout.updatedAt = Date.now();
      const idx = data.workouts.findIndex(function(w){ return w.id === workout.id; });
      if (idx >= 0) {
        data.workouts[idx] = workout;
      } else {
        if (!workout.createdAt) workout.createdAt = Date.now();
        if (!workout.id) workout.id = Utils.generateId();
        data.workouts.push(workout);
      }
      this._save(data);
      return workout;
    },

    rename: function(id, newName) {
      const w = this.get(id);
      if (!w) return null;
      w.name = newName;
      this.save(w);
      return w;
    },

    delete: function(id) {
      const data = this._load();
      data.workouts = data.workouts.filter(function(w){ return w.id !== id; });
      this._save(data);
    },

    /** Duplique un entraînement (avec nouvel id) */
    duplicate: function(id) {
      const orig = this.get(id);
      if (!orig) return null;
      const copy = JSON.parse(JSON.stringify(orig));
      copy.id = Utils.generateId();
      copy.name = orig.name + ' (copie)';
      copy.createdAt = Date.now();
      copy.updatedAt = Date.now();
      copy.blocks = copy.blocks.map(function(b){
        return { id: Utils.generateId(), duration: b.duration, level: b.level };
      });
      this.save(copy);
      return copy;
    },

    /** Export : retourne une string JSON */
    exportJson: function() {
      return JSON.stringify(this._load(), null, 2);
    },

    /** Import : merge avec l'existant. Renvoie {imported, skipped} */
    importJson: function(jsonStr, mode) {
      mode = mode || 'merge'; // 'merge' | 'replace'
      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        throw new Error('JSON invalide : ' + e.message);
      }
      if (!parsed || !Array.isArray(parsed.workouts)) {
        throw new Error('Format invalide : workouts manquant');
      }
      let imported = 0, skipped = 0;
      if (mode === 'replace') {
        this._save({ workouts: parsed.workouts });
        imported = parsed.workouts.length;
      } else {
        const data = this._load();
        const existingIds = new Set(data.workouts.map(function(w){ return w.id; }));
        parsed.workouts.forEach(function(w){
          if (existingIds.has(w.id)) {
            // Renomme et regénère l'ID pour éviter conflit
            const copy = JSON.parse(JSON.stringify(w));
            copy.id = Utils.generateId();
            copy.name = w.name + ' (importé)';
            data.workouts.push(copy);
            imported++;
          } else {
            data.workouts.push(w);
            imported++;
          }
        });
        this._save(data);
      }
      return { imported: imported, skipped: skipped };
    },
  };

  // Helpers de manipulation des blocs (en mémoire, sans persistance auto)
  const Blocks = {
    create: function(duration, level) {
      return {
        id: Utils.generateId(),
        duration: duration || 60,
        level: level || 5,
      };
    },
    /** Durée totale d'un entraînement en secondes */
    totalDuration: function(workout) {
      if (!workout || !workout.blocks) return 0;
      return workout.blocks.reduce(function(sum, b){ return sum + (b.duration || 0); }, 0);
    },
    /** Trouve le bloc en cours selon le temps écoulé */
    blockAtTime: function(workout, elapsedSec) {
      if (!workout || !workout.blocks) return null;
      let acc = 0;
      for (let i = 0; i < workout.blocks.length; i++) {
        const b = workout.blocks[i];
        if (elapsedSec < acc + b.duration) {
          return {
            index: i,
            block: b,
            startTime: acc,
            endTime: acc + b.duration,
            elapsedInBlock: elapsedSec - acc,
            remainingInBlock: acc + b.duration - elapsedSec,
          };
        }
        acc += b.duration;
      }
      return null; // entraînement terminé
    },
  };

  // ============================================================
  // BLE DRIVER : connexion + pilotage FTMS du Woodrover
  // ============================================================
  /**
   * Usage :
   *   const driver = new RowerDriver();
   *   driver.on('data', function(metrics) { ... });
   *   driver.on('status', function(s) { ... });
   *   await driver.connect();
   *   await driver.setResistanceLevel(8);
   */
  function RowerDriver() {
    this.device = null;
    this.server = null;
    this.controlPoint = null;
    this.connected = false;
    this.lastData = {};
    this.handlers = { data: [], status: [], log: [], cpResponse: [] };
    // Cache de la dernière résistance envoyée (pour éviter le spam)
    this._lastSentLevel = null;
  }

  RowerDriver.prototype.on = function(event, fn) {
    if (this.handlers[event]) this.handlers[event].push(fn);
  };

  RowerDriver.prototype._emit = function(event, payload) {
    (this.handlers[event] || []).forEach(function(fn) {
      try { fn(payload); } catch(e) { console.error(event + ' handler error', e); }
    });
  };

  RowerDriver.prototype._log = function(msg, type) {
    this._emit('log', { msg: msg, type: type || 'info', ts: Date.now() });
  };

  RowerDriver.prototype._parseRowerData = function(dv) {
    const flags = dv.getUint16(0, true);
    let offset = 2;
    const d = {};
    const moreData = (flags & 0x0001) !== 0;
    if (!moreData) {
      if (offset + 1 <= dv.byteLength) { d.strokeRate = dv.getUint8(offset) * 0.5; offset += 1; }
      if (offset + 2 <= dv.byteLength) { d.strokeCount = dv.getUint16(offset, true); offset += 2; }
    }
    if ((flags & 0x0002) && offset + 1 <= dv.byteLength) { d.avgStrokeRate = dv.getUint8(offset) * 0.5; offset += 1; }
    if ((flags & 0x0004) && offset + 3 <= dv.byteLength) {
      d.totalDistance = dv.getUint8(offset) | (dv.getUint8(offset+1) << 8) | (dv.getUint8(offset+2) << 16);
      offset += 3;
    }
    if ((flags & 0x0008) && offset + 2 <= dv.byteLength) { d.instantPace = dv.getUint16(offset, true); offset += 2; }
    if ((flags & 0x0010) && offset + 2 <= dv.byteLength) { d.avgPace = dv.getUint16(offset, true); offset += 2; }
    if ((flags & 0x0020) && offset + 2 <= dv.byteLength) { d.instantPower = dv.getInt16(offset, true); offset += 2; }
    if ((flags & 0x0040) && offset + 2 <= dv.byteLength) { d.avgPower = dv.getInt16(offset, true); offset += 2; }
    if ((flags & 0x0080) && offset + 2 <= dv.byteLength) {
      const raw = dv.getInt16(offset, true);
      d.resistanceRaw = raw;
      d.resistance = BLE.rawToLevel(raw);
      offset += 2;
    }
    if ((flags & 0x0100)) {
      if (offset + 2 <= dv.byteLength) { d.totalEnergy = dv.getUint16(offset, true); offset += 2; }
      if (offset + 2 <= dv.byteLength) { d.energyPerHour = dv.getUint16(offset, true); offset += 2; }
      if (offset + 1 <= dv.byteLength) { d.energyPerMinute = dv.getUint8(offset); offset += 1; }
    }
    if ((flags & 0x0200) && offset + 1 <= dv.byteLength) { d.heartRate = dv.getUint8(offset); offset += 1; }
    if ((flags & 0x0400) && offset + 1 <= dv.byteLength) { d.metabolicEquivalent = dv.getUint8(offset) * 0.1; offset += 1; }
    if ((flags & 0x0800) && offset + 2 <= dv.byteLength) { d.elapsedTime = dv.getUint16(offset, true); offset += 2; }
    if ((flags & 0x1000) && offset + 2 <= dv.byteLength) { d.remainingTime = dv.getUint16(offset, true); offset += 2; }
    return d;
  };

  RowerDriver.prototype._onRowerNotif = function(event) {
    const d = this._parseRowerData(event.target.value);
    Object.assign(this.lastData, d);
    this._emit('data', Object.assign({}, this.lastData));
  };

  RowerDriver.prototype._onHrNotif = function(event) {
    const dv = event.target.value;
    const flags = dv.getUint8(0);
    const is16 = (flags & 0x01) !== 0;
    const hr = is16 ? dv.getUint16(1, true) : dv.getUint8(1);
    this.lastData.heartRate = hr;
    this._emit('data', Object.assign({}, this.lastData));
  };

  RowerDriver.prototype._onCpResp = function(event) {
    const dv = event.target.value;
    if (dv.byteLength >= 3 && dv.getUint8(0) === BLE.OP.RESPONSE_CODE) {
      const op = dv.getUint8(1);
      const result = dv.getUint8(2);
      const text = BLE.RESULT[result] || ('Code 0x' + result.toString(16));
      this._log('↩ CP op=0x' + op.toString(16).padStart(2,'0') + ' → ' + text, result === 1 ? 'ok' : 'warn');
      this._emit('cpResponse', { op: op, result: result, text: text, success: result === 1 });
    }
  };

  RowerDriver.prototype.connect = async function() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth indisponible. Sur iOS, utilise Bluefy.');
    }
    this._log('▶ Connexion...', 'info');
    this._emit('status', 'connecting');
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE.UUID.FTMS_SERVICE] }],
        optionalServices: [BLE.UUID.FTMS_SERVICE, BLE.UUID.HRS_SERVICE],
      });
      this._log('Sélectionné : ' + (this.device.name || '(sans nom)'), 'ok');
      this.device.addEventListener('gattserverdisconnected', this._onDisconnected.bind(this));

      this.server = await this.device.gatt.connect();
      this._log('GATT connecté', 'ok');

      const ftms = await this.server.getPrimaryService(BLE.UUID.FTMS_SERVICE);

      // Rower Data
      const rd = await ftms.getCharacteristic(BLE.UUID.ROWER_DATA);
      await rd.startNotifications();
      rd.addEventListener('characteristicvaluechanged', this._onRowerNotif.bind(this));

      // Control Point
      this.controlPoint = await ftms.getCharacteristic(BLE.UUID.CONTROL_POINT);
      await this.controlPoint.startNotifications();
      this.controlPoint.addEventListener('characteristicvaluechanged', this._onCpResp.bind(this));

      // Heart Rate (optionnel)
      try {
        const hrs = await this.server.getPrimaryService(BLE.UUID.HRS_SERVICE);
        const hrm = await hrs.getCharacteristic(BLE.UUID.HRM_CHARACTERISTIC);
        await hrm.startNotifications();
        hrm.addEventListener('characteristicvaluechanged', this._onHrNotif.bind(this));
        this._log('✓ Heart Rate activé', 'ok');
      } catch(e) {}

      // Étape critique : Request Control (sinon SetRes refuse)
      await this._sendCp([BLE.OP.REQUEST_CONTROL], 'Request Control');
      await new Promise(function(r){ setTimeout(r, 400); });

      this.connected = true;
      this._log('✓ Prêt — pilotage de résistance disponible', 'ok');
      this._emit('status', 'connected');
      return true;
    } catch (e) {
      this._log('Erreur connexion : ' + Utils.describeError(e), 'err');
      this._emit('status', 'error');
      throw e;
    }
  };

  RowerDriver.prototype._sendCp = async function(bytes, label) {
    if (!this.controlPoint) throw new Error('Control Point indisponible');
    const buf = new Uint8Array(bytes);
    this._log('→ ' + label + ' : ' + Array.from(buf).map(function(b){return b.toString(16).padStart(2,'0');}).join(' '), 'cp');
    await this.controlPoint.writeValue(buf);
  };

  /** Envoie SetTargetResistance avec encodage uint8 spécifique Domyos */
  RowerDriver.prototype.setResistanceLevel = async function(level) {
    level = Math.max(BLE.MIN_LEVEL, Math.min(BLE.MAX_LEVEL, Math.round(level)));
    // Ne renvoie pas si déjà au même niveau (évite spam)
    if (this._lastSentLevel === level) return;
    const raw = BLE.levelToRaw(level);
    try {
      await this._sendCp([BLE.OP.SET_TARGET_RESISTANCE, raw], 'SetRes niv ' + level);
      this._lastSentLevel = level;
    } catch (e) {
      this._log('Erreur SetRes : ' + Utils.describeError(e), 'err');
      throw e;
    }
  };

  /** Re-Request Control au cas où la machine perdrait l'autorité */
  RowerDriver.prototype.reRequestControl = async function() {
    await this._sendCp([BLE.OP.REQUEST_CONTROL], 'Request Control');
    this._lastSentLevel = null; // force le re-send au prochain setRes
  };

  RowerDriver.prototype._onDisconnected = function() {
    this._log('Déconnexion GATT', 'warn');
    this.connected = false;
    this.controlPoint = null;
    this._lastSentLevel = null;
    this._emit('status', 'disconnected');
  };

  RowerDriver.prototype.disconnect = function() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.connected = false;
    this.controlPoint = null;
    this._lastSentLevel = null;
  };

  // ============================================================
  // SYNC : sauvegarde et récupération via GitHub Gist
  // ============================================================
  /**
   * Trois modes selon la config :
   * - 'local'    : pas de sync, juste localStorage (par défaut)
   * - 'owner'    : token GitHub configuré → lecture + écriture du Gist
   * - 'viewer'   : URL Gist configurée mais pas de token → lecture seule
   *
   * Config stockée séparément en localStorage :
   * - rameur_sync_token  : token GitHub (mode owner)
   * - rameur_sync_gistid : ID du Gist (mode owner)
   * - rameur_sync_url    : URL raw du Gist (mode viewer)
   */
  const SYNC_TOKEN_KEY = 'rameur_sync_token';
  const SYNC_GISTID_KEY = 'rameur_sync_gistid';
  const SYNC_URL_KEY = 'rameur_sync_url';
  const SYNC_FILENAME = 'rameur-workouts.json';

  const Sync = {
    /** Retourne le mode actuel : 'local' | 'owner' | 'viewer' */
    getMode: function() {
      const token = localStorage.getItem(SYNC_TOKEN_KEY);
      const gistId = localStorage.getItem(SYNC_GISTID_KEY);
      const url = localStorage.getItem(SYNC_URL_KEY);
      if (token && gistId) return 'owner';
      if (url) return 'viewer';
      return 'local';
    },

    /** Infos pour affichage UI */
    getInfo: function() {
      const mode = this.getMode();
      const info = { mode: mode };
      if (mode === 'owner') {
        info.gistId = localStorage.getItem(SYNC_GISTID_KEY);
        info.gistUrl = 'https://gist.github.com/' + info.gistId;
        info.shareUrl = this._buildShareUrl();
      } else if (mode === 'viewer') {
        info.gistRawUrl = localStorage.getItem(SYNC_URL_KEY);
      }
      return info;
    },

    /** Construit l'URL de partage à donner à un viewer (mode owner uniquement) */
    _buildShareUrl: function() {
      const gistId = localStorage.getItem(SYNC_GISTID_KEY);
      const token = localStorage.getItem(SYNC_TOKEN_KEY);
      if (!gistId || !token) return null;
      // On a besoin du nom d'utilisateur GitHub pour construire l'URL raw
      // On le stocke aussi
      const username = localStorage.getItem('rameur_sync_username') || '';
      if (!username) return null;
      const appBase = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
      const rawUrl = 'https://gist.githubusercontent.com/' + username + '/' + gistId + '/raw/' + SYNC_FILENAME;
      return appBase + '?gist=' + encodeURIComponent(rawUrl);
    },

    /** Active le mode owner : valide le token, trouve/crée le Gist, fait premier push */
    setupOwner: async function(token) {
      if (!token || !token.startsWith('github_pat_') && !token.startsWith('ghp_')) {
        throw new Error('Token GitHub invalide (doit commencer par github_pat_ ou ghp_)');
      }
      // Test du token : récupère l'username
      const userResp = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
      });
      if (!userResp.ok) {
        throw new Error('Token invalide ou sans permission (HTTP ' + userResp.status + ')');
      }
      const user = await userResp.json();
      localStorage.setItem('rameur_sync_username', user.login);

      // Cherche un Gist existant avec notre filename
      const gistsResp = await fetch('https://api.github.com/gists', {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
      });
      if (!gistsResp.ok) throw new Error('Impossible de lister les Gists');
      const gists = await gistsResp.json();
      let gist = gists.find(function(g) {
        return g.files && g.files[SYNC_FILENAME];
      });

      if (!gist) {
        // Crée un nouveau Gist privé avec le contenu local
        const localData = Storage.exportJson();
        const createResp = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            description: 'Rameur Woodrover - workouts',
            public: false,
            files: {
              [SYNC_FILENAME]: { content: localData },
            },
          }),
        });
        if (!createResp.ok) {
          const t = await createResp.text();
          throw new Error('Création Gist échouée : ' + t);
        }
        gist = await createResp.json();
      }

      localStorage.setItem(SYNC_TOKEN_KEY, token);
      localStorage.setItem(SYNC_GISTID_KEY, gist.id);
      // Supprime l'éventuelle config viewer (incompatible)
      localStorage.removeItem(SYNC_URL_KEY);

      return { username: user.login, gistId: gist.id, shareUrl: this._buildShareUrl() };
    },

    /** Active le mode viewer : valide l'URL en faisant un fetch, charge les données */
    setupViewer: async function(rawUrl) {
      if (!rawUrl) throw new Error('URL manquante');
      // Test du fetch
      const resp = await fetch(rawUrl, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('URL inaccessible (HTTP ' + resp.status + ')');
      const text = await resp.text();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch(e) { throw new Error('Le contenu distant n\'est pas un JSON valide'); }
      if (!parsed.workouts || !Array.isArray(parsed.workouts)) {
        throw new Error('Format invalide : champ "workouts" manquant');
      }
      // OK : remplace tout en local et enregistre l'URL
      localStorage.setItem(SYNC_URL_KEY, rawUrl);
      // Supprime l'éventuelle config owner
      localStorage.removeItem(SYNC_TOKEN_KEY);
      localStorage.removeItem(SYNC_GISTID_KEY);
      localStorage.removeItem('rameur_sync_username');
      // Importe les workouts (replace)
      Storage.importJson(text, 'replace');
      return { count: parsed.workouts.length };
    },

    /** Pull : récupère la version distante et remplace la locale */
    pull: async function() {
      const mode = this.getMode();
      if (mode === 'local') throw new Error('Sync non configurée');
      let rawUrl;
      let headers = {};
      if (mode === 'owner') {
        const token = localStorage.getItem(SYNC_TOKEN_KEY);
        const gistId = localStorage.getItem(SYNC_GISTID_KEY);
        // Récupère via API (renvoie le contenu du fichier)
        const resp = await fetch('https://api.github.com/gists/' + gistId, {
          headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
          cache: 'no-cache',
        });
        if (!resp.ok) throw new Error('Pull échoué (HTTP ' + resp.status + ')');
        const gist = await resp.json();
        const file = gist.files && gist.files[SYNC_FILENAME];
        if (!file) throw new Error('Fichier ' + SYNC_FILENAME + ' absent du Gist');
        // Si file.truncated, fetch via raw_url
        let content = file.content;
        if (file.truncated) {
          const rawResp = await fetch(file.raw_url, { cache: 'no-cache' });
          content = await rawResp.text();
        }
        Storage.importJson(content, 'replace');
        return { source: 'owner', gistId: gistId };
      } else {
        rawUrl = localStorage.getItem(SYNC_URL_KEY);
        // Ajoute un cache-buster pour forcer le re-fetch
        const url = rawUrl + (rawUrl.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
        const resp = await fetch(url, { cache: 'no-cache' });
        if (!resp.ok) throw new Error('Pull échoué (HTTP ' + resp.status + ')');
        const text = await resp.text();
        Storage.importJson(text, 'replace');
        return { source: 'viewer' };
      }
    },

    /** Push : envoie la version locale vers le Gist (mode owner uniquement) */
    push: async function() {
      const mode = this.getMode();
      if (mode !== 'owner') throw new Error('Push réservé au mode owner');
      const token = localStorage.getItem(SYNC_TOKEN_KEY);
      const gistId = localStorage.getItem(SYNC_GISTID_KEY);
      const localData = Storage.exportJson();
      const resp = await fetch('https://api.github.com/gists/' + gistId, {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: { [SYNC_FILENAME]: { content: localData } },
        }),
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('Push échoué : ' + t);
      }
      return { ok: true };
    },

    /** Déconnecte : efface la config sync (ne touche pas le Gist distant) */
    disconnect: function() {
      localStorage.removeItem(SYNC_TOKEN_KEY);
      localStorage.removeItem(SYNC_GISTID_KEY);
      localStorage.removeItem(SYNC_URL_KEY);
      localStorage.removeItem('rameur_sync_username');
    },

    /** Détecte un ?gist=... dans l'URL et configure auto le mode viewer */
    detectUrlConfig: async function() {
      const params = new URLSearchParams(window.location.search);
      const gistParam = params.get('gist');
      if (!gistParam) return null;
      try {
        const result = await this.setupViewer(gistParam);
        // Retire le paramètre de l'URL pour ne pas re-déclencher au prochain reload
        const cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, '', cleanUrl);
        return result;
      } catch (e) {
        console.error('Auto-setup viewer failed', e);
        return null;
      }
    },
  };

  // ============================================================
  // EXPORT
  // ============================================================
  global.RameurApp = {
    BLE: BLE,
    Utils: Utils,
    Toast: Toast,
    Storage: Storage,
    Blocks: Blocks,
    RowerDriver: RowerDriver,
    Sync: Sync,
  };
})(window);
