// ThumbnailCache.js — Async thumbnail generation and on-disk cache management.
//
// Cache directory: ~/.local/share/wallshift/thumbnails/
// Cache key: MD5 of the absolute image path + size suffix + '.jpg'
//   250×140 (landscape, medium): _l250    140×250 (portrait, medium): _p250
//   any other size W×H:          _WxH     (the carousel's small / large sizes)
// Max concurrent imagetool.py jobs: 4 (queues excess requests, never drops them)

const GLib = imports.gi.GLib;
const Gio  = imports.gi.Gio;

const Utils = require('./modules/Utils');   // relative to the applet dir, as in applet.js

const MAX_CONCURRENT = 4;

// The medium sizes keep their pre-0.1.0 suffixes so existing caches stay valid.
function sizeSuffix(w, h) {
    if (w === 250 && h === 140) return '_l250';
    if (w === 140 && h === 250) return '_p250';
    return '_' + w + 'x' + h;
}

var ThumbnailCache = class ThumbnailCache {

    // toolPath: absolute path of imagetool.py in the applet folder.
    constructor(stateDir, toolPath) {
        this._cacheDir   = stateDir + '/thumbnails';
        this._toolPath   = toolPath;
        this._activeJobs = 0;
        this._queue      = [];       // pending { imagePath, isPortrait, cachePath, callbacks[] }
        this._inFlight   = new Map(); // imagePath → callbacks[] (jobs currently running)
        this._destroyed  = false;
        Utils.ensureDir(this._cacheDir);
    }

    // Drop every queued job and ignore the results of the ones already running.
    // Called when the applet leaves the panel: an imagetool.py process that is mid-way
    // finishes on its own and its file stays in the cache for next time, but no
    // callback into a torn-down carousel is made.
    destroy() {
        this._destroyed = true;
        this._queue     = [];
        this._inFlight.clear();
    }

    // Returns the expected cache path for an image at w×h px.
    // Does NOT check whether the file exists — use ensureThumbnail for that.
    getThumbnailPath(imagePath, w, h) {
        let hash = GLib.compute_checksum_for_string(
            GLib.ChecksumType.MD5, imagePath, -1);
        return this._cacheDir + '/' + hash + sizeSuffix(w, h) + '.jpg';
    }

    // Ensures a thumbnail exists for the given image.
    //
    // If the cache file is already on disk, fires callback(null, cachePath) immediately.
    // Otherwise generates it via imagetool.py (async). If a job for this path is already
    // in flight, the callback is queued on that job rather than spawning a duplicate.
    //
    // callback: function(err, cachePath)
    ensureThumbnail(imagePath, w, h, callback) {
        let cachePath = this.getThumbnailPath(imagePath, w, h);

        if (Utils.fileExists(cachePath) && this._cacheFileValid(cachePath)) {
            callback(null, cachePath);
            return;
        }

        // Piggyback on an existing in-flight job for the same file.
        if (this._inFlight.has(cachePath)) {
            this._inFlight.get(cachePath).push(callback);
            return;
        }

        // Queue for later dispatch.
        this._queue.push({ imagePath, w, h, cachePath, callbacks: [callback] });
        this._drain();
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    _drain() {
        while (this._activeJobs < MAX_CONCURRENT && this._queue.length > 0) {
            let job = this._queue.shift();
            this._inFlight.set(job.cachePath, job.callbacks);
            this._activeJobs++;
            this._runJob(job);
        }
    }

    // Returns false if the cache file is missing, empty, or unreadable.
    // An empty file is left by older versions whose thumbnail run failed mid-write.
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
        Utils.spawnAsync([
            '/usr/bin/python3', this._toolPath, 'thumb',
            job.imagePath, String(job.w), String(job.h), job.cachePath
        ], (err, _stdout, stderr, exitCode) => {
            this._activeJobs--;
            if (this._destroyed) return;
            let callbacks = this._inFlight.get(job.cachePath) || [];
            this._inFlight.delete(job.cachePath);

            if (err || exitCode !== 0) {
                Utils.warn('Thumbnail failed for ' + job.imagePath +
                    ': ' + ((stderr || '').trim() || (err && err.message) || 'exit ' + exitCode));
                for (let cb of callbacks) cb(new Error('thumbnail generation failed'), null);
            } else {
                for (let cb of callbacks) cb(null, job.cachePath);
            }

            this._drain();
        });
    }
};
