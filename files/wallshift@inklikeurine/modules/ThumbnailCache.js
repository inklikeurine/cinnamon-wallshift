// ThumbnailCache.js — Async thumbnail generation and on-disk cache management.
//
// Cache directory: ~/.local/share/wallshift/thumbnails/
// Cache key: MD5 of the absolute image path + size suffix + '.jpg'
//   Landscape: _l250 (250×140 px)
//   Portrait:  _p250 (140×250 px)
// Max concurrent ImageMagick jobs: 4 (queues excess requests, never drops them)

const GLib = imports.gi.GLib;
const Gio  = imports.gi.Gio;

const Utils = require('./modules/Utils');   // relative to the applet dir, as in applet.js

const MAX_CONCURRENT = 4;

var ThumbnailCache = class ThumbnailCache {

    constructor(stateDir) {
        this._cacheDir   = stateDir + '/thumbnails';
        this._activeJobs = 0;
        this._queue      = [];       // pending { imagePath, isPortrait, cachePath, callbacks[] }
        this._inFlight   = new Map(); // imagePath → callbacks[] (jobs currently running)
        this._destroyed  = false;
        Utils.ensureDir(this._cacheDir);
    }

    // Drop every queued job and ignore the results of the ones already running.
    // Called when the applet leaves the panel: a convert process that is mid-way
    // finishes on its own and its file stays in the cache for next time, but no
    // callback into a torn-down carousel is made.
    destroy() {
        this._destroyed = true;
        this._queue     = [];
        this._inFlight.clear();
    }

    // Returns the expected cache path for a given image and orientation.
    // Does NOT check whether the file exists — use ensureThumbnail for that.
    getThumbnailPath(imagePath, isPortrait) {
        let hash   = GLib.compute_checksum_for_string(
            GLib.ChecksumType.MD5, imagePath, -1);
        let suffix = isPortrait ? '_p250' : '_l250';
        return this._cacheDir + '/' + hash + suffix + '.jpg';
    }

    // Ensures a thumbnail exists for the given image.
    //
    // If the cache file is already on disk, fires callback(null, cachePath) immediately.
    // Otherwise generates it via ImageMagick (async). If a job for this path is already
    // in flight, the callback is queued on that job rather than spawning a duplicate.
    //
    // callback: function(err, cachePath)
    ensureThumbnail(imagePath, isPortrait, callback) {
        let cachePath = this.getThumbnailPath(imagePath, isPortrait);

        if (Utils.fileExists(cachePath) && this._cacheFileValid(cachePath)) {
            callback(null, cachePath);
            return;
        }

        // Piggyback on an existing in-flight job for the same path.
        if (this._inFlight.has(imagePath)) {
            this._inFlight.get(imagePath).push(callback);
            return;
        }

        // Queue for later dispatch.
        this._queue.push({ imagePath, isPortrait, cachePath, callbacks: [callback] });
        this._drain();
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    _drain() {
        while (this._activeJobs < MAX_CONCURRENT && this._queue.length > 0) {
            let job = this._queue.shift();
            this._inFlight.set(job.imagePath, job.callbacks);
            this._activeJobs++;
            this._runJob(job);
        }
    }

    // Returns false if the cache file is missing, empty, or unreadable.
    // An empty file means a previous ImageMagick run failed mid-write.
    _cacheFileValid(cachePath) {
        try {
            let info = Gio.File.new_for_path(cachePath)
                .query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            return info.get_size() > 0;
        } catch(e) {
            return false;
        }
    }

    _runJob(job) {
        let w    = job.isPortrait ? '140' : '250';
        let h    = job.isPortrait ? '250' : '140';
        let size = w + 'x' + h;

        Utils.spawnAsync([
            'convert', job.imagePath,
            '-thumbnail', size + '^',
            '-gravity', 'Center',
            '-extent', size,
            '-quality', '85',
            '-strip',
            job.cachePath
        ], (err, _stdout, stderr, exitCode) => {
            this._activeJobs--;
            if (this._destroyed) return;
            let callbacks = this._inFlight.get(job.imagePath) || [];
            this._inFlight.delete(job.imagePath);

            if (err || exitCode !== 0) {
                Utils.warn('Thumbnail failed for ' + job.imagePath +
                    ': ' + (stderr || (err && err.message) || 'exit ' + exitCode));
                for (let cb of callbacks) cb(new Error('thumbnail generation failed'), null);
            } else {
                for (let cb of callbacks) cb(null, job.cachePath);
            }

            this._drain();
        });
    }
};
