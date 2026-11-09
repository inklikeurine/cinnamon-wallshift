// ThumbnailCache.js — Async thumbnail generation and on-disk cache management.
//
// Cache directory: ~/.local/share/wallshift/thumbnails/
// Cache key: MD5 of the absolute image path + size suffix + '.jpg'
//   250×140 (landscape, medium): _l250    140×250 (portrait, medium): _p250
//   any other size W×H:          _WxH     (the carousel's small / large sizes)
//
// Thumbnails are made by `imagetool.py thumbs`, many per process: starting Python
// costs about ten times one thumbnail, so requests made together (the carousel
// asks for a screenful in one go) are gathered on the next idle and split over at
// most MAX_WORKERS processes. Each result arrives as its own line, so a thumbnail
// shows as soon as it is ready, not when its whole batch is. Requests are queued,
// never dropped.

const GLib = imports.gi.GLib;
const Gio  = imports.gi.Gio;

const Utils = require('./modules/Utils');   // relative to the applet dir, as in applet.js

const MAX_WORKERS = 2;
const MAX_BATCH   = 16;

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
        this._workers    = 0;
        this._queue      = [];       // pending { imagePath, w, h, cachePath, callbacks[] }
        this._inFlight   = new Map(); // cachePath → callbacks[] (jobs a worker has been given)
        this._drainId    = 0;        // idle source that gathers this tick's requests
        this._destroyed  = false;
        Utils.ensureDir(this._cacheDir);
    }

    // Drop every queued job and ignore the results of the ones already running.
    // Called when the applet leaves the panel: a worker that is mid-way finishes
    // on its own and its files stay in the cache for next time, but no callback
    // into a torn-down carousel is made.
    destroy() {
        this._destroyed = true;
        if (this._drainId) { GLib.source_remove(this._drainId); this._drainId = 0; }
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
    // Otherwise queues it for imagetool.py (async). A request for a file that is
    // already queued or being made joins that job rather than adding a duplicate.
    //
    // callback: function(err, cachePath)
    ensureThumbnail(imagePath, w, h, callback) {
        let cachePath = this.getThumbnailPath(imagePath, w, h);

        if (Utils.fileExists(cachePath) && this._cacheFileValid(cachePath)) {
            callback(null, cachePath);
            return;
        }

        if (this._inFlight.has(cachePath)) {
            this._inFlight.get(cachePath).push(callback);
            return;
        }
        let queued = this._queue.find(j => j.cachePath === cachePath);
        if (queued) {
            queued.callbacks.push(callback);
            return;
        }

        this._queue.push({ imagePath, w, h, cachePath, callbacks: [callback] });
        this._scheduleDrain();
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    _scheduleDrain() {
        if (this._drainId || this._destroyed) return;
        this._drainId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._drainId = 0;
            this._drain();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Hand the queue to free workers, split evenly (at most MAX_BATCH each).
    _drain() {
        while (!this._destroyed && this._workers < MAX_WORKERS && this._queue.length > 0) {
            let free = MAX_WORKERS - this._workers;
            let size = Math.min(MAX_BATCH, Math.ceil(this._queue.length / free));
            let batch = this._queue.splice(0, size);
            for (let job of batch) this._inFlight.set(job.cachePath, job.callbacks);
            this._runBatch(batch);
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

    _runBatch(batch) {
        this._workers++;
        let pending = new Map(batch.map(job => [job.cachePath, job]));
        let noise = [];   // anything imagetool printed that is not a result line

        let settle = (cachePath, message) => {
            let job = pending.get(cachePath);
            if (!job) return;
            pending.delete(cachePath);
            let callbacks = this._inFlight.get(cachePath) || [];
            this._inFlight.delete(cachePath);
            if (this._destroyed) return;
            if (message) {
                Utils.warn('Thumbnail failed for ' + job.imagePath + ': ' + message);
                for (let cb of callbacks) cb(new Error('thumbnail generation failed'), null);
            } else {
                for (let cb of callbacks) cb(null, cachePath);
            }
        };

        let jobs = batch.map(job => [job.imagePath, job.w, job.h, job.cachePath]);
        Utils.spawnLines(['/usr/bin/python3', this._toolPath, 'thumbs', JSON.stringify(jobs)], line => {
            let msg = null;
            try { msg = JSON.parse(line); } catch(e) { /* not a result line */ }
            if (msg && typeof msg.output === 'string') settle(msg.output, msg.ok ? null : (msg.error || 'failed'));
            else if (line.trim()) noise.push(line.trim());
        }, (err, exitCode) => {
            this._workers--;
            // Jobs the worker never reported on (it crashed or could not start).
            let reason = (err && err.message) || noise.slice(-1)[0] || 'imagetool exited ' + exitCode;
            for (let cachePath of [...pending.keys()]) settle(cachePath, reason);
            this._drain();
        });
    }
};
