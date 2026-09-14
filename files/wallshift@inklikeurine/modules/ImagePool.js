// ImagePool.js — Scans folders for images and manages a shuffle/sequential queue.
// One instance per monitor in independent mode; one shared instance in sync mode.
//
// Order modes:
//   'no-repeat'  — Fisher-Yates shuffle; no repeats until the full pool is seen.
//                  When the queue empties, reshuffles all images. (Default)
//   'random'     — Pure random: picks any image each tick via Math.random().
//                  The same image may appear on consecutive changes.
//   'sequential' — Alphabetical by full path, wraps at the end.

const GLib = imports.gi.GLib;

const Utils = require('./modules/Utils');   // relative to the applet dir, as in applet.js

var ImagePool = class ImagePool {

    constructor(outputName) {
        this._outputName = outputName;   // Used in log messages only
        this._folders = [];
        this._allImages = [];            // Full discovered set (after trash filter)
        this._queue = [];                // Remaining in current no-repeat cycle
        this._trashedPaths = new Set();
        this._order = 'no-repeat';       // 'no-repeat' | 'random' | 'sequential'
        this._sequentialIndex = 0;
        this._scanGen = 0;               // Invalidates the results of a superseded scan()
    }

    setFolders(folders) {
        this._folders = (folders || []).filter(f => Utils.dirExists(f));
    }

    setTrashedPaths(paths) {
        this._trashedPaths = new Set(paths || []);
    }

    // order: 'no-repeat' | 'random' | 'sequential'
    // Also accepts legacy booleans: true → 'sequential', false → 'no-repeat'.
    setOrder(order) {
        if (order === true)  order = 'sequential';
        if (order === false) order = 'no-repeat';
        this._order = order || 'no-repeat';
    }

    // Scan all configured folders asynchronously. `callback()` fires once the pool
    // is populated; until then next() returns null (callers fall back to the
    // current image). If scan() is called again before the previous one finishes,
    // the earlier results are discarded so the pool always reflects the latest
    // configuration. Never blocks the main thread.
    scan(callback) {
        let gen     = ++this._scanGen;
        let folders = this._folders.slice();
        let found   = [];
        let pending = folders.length;

        let finish = () => {
            if (gen !== this._scanGen) return;   // superseded by a newer scan()
            this._allImages = found.filter(p => !this._trashedPaths.has(p));

            if (this._order === 'sequential') {
                this._allImages.sort();
                this._sequentialIndex = 0;
            } else {
                this._queue = Utils.shuffle(this._allImages.slice());
            }
            if (callback) callback();
        };

        if (pending === 0) { finish(); return; }
        for (let folder of folders) {
            this._scanFolder(folder, paths => {
                found.push(...paths);
                if (--pending === 0) finish();
            });
        }
    }

    // Returns the next image path, or null if the pool is empty.
    next() {
        if (this._allImages.length === 0) return null;

        if (this._order === 'sequential') {
            let img = this._allImages[this._sequentialIndex % this._allImages.length];
            this._sequentialIndex++;
            return img;
        }

        if (this._order === 'random') {
            // Pure random — pick any image; the same image may appear consecutively.
            return this._allImages[Math.floor(Math.random() * this._allImages.length)];
        }

        // 'no-repeat': dequeue from shuffled list; reshuffle when exhausted.
        // No image repeats until the full pool has been seen.
        if (this._queue.length === 0) {
            this._queue = Utils.shuffle(this._allImages.slice());
        }
        return this._queue.shift();
    }

    getCount() {
        return this._allImages.length;
    }

    // Returns a sorted copy of all images currently in the pool.
    // Used by the carousel to build its stable alphabetical browse list.
    getImages() {
        return this._allImages.slice().sort();
    }

    // Remove a path (e.g. after trash). Takes effect immediately.
    removePath(path) {
        this._trashedPaths.add(path);
        this._allImages = this._allImages.filter(p => p !== path);
        let wasQueued = this._queue.includes(path);
        this._queue   = this._queue.filter(p => p !== path);
        // In no-repeat mode: if the removed path was still pending in the current
        // cycle and its removal emptied the queue, seed the next cycle now. This
        // prevents next() from triggering an unexpected full reshuffle mid-cycle
        // (most visible when monitors share a folder and trashing from one monitor
        // removes the last queued entry from another monitor's pool).
        if (this._order === 'no-repeat' && wasQueued
                && this._queue.length === 0 && this._allImages.length > 0) {
            this._queue = Utils.shuffle(this._allImages.slice());
        }
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    // Run `find` for one folder via Gio.Subprocess and hand back the matching paths.
    // argv form (no shell) so folder names with quotes or spaces are safe.
    _scanFolder(folderPath, callback) {
        let argv = ['find', folderPath, '-not', '-path', '*/.*', '-type', 'f', '('];
        Utils.IMAGE_EXTENSIONS.forEach((ext, i) => {
            if (i > 0) argv.push('-o');
            argv.push('-iname', '*' + ext);
        });
        argv.push(')');

        Utils.spawnAsync(argv, (err, stdout, stderr, exitCode) => {
            if (err) {
                Utils.error('find failed for ' + folderPath + ': ' + err.message);
                callback([]);
                return;
            }
            // find exits 1 if any subdirectory was unreadable but still lists the
            // rest — keep whatever it found and just note the problem.
            if (exitCode !== 0) {
                Utils.warn('find reported errors under ' + folderPath +
                    (stderr ? ': ' + stderr.trim().split('\n')[0] : ''));
            }
            let lines = (stdout || '')
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0 && Utils.isImageFile(l));
            callback(lines);
        });
    }
};
