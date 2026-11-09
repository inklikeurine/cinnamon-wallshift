// Actions.js — every command Wallshift offers, by name.
//
// The panel menu, the carousel buttons, panel scroll / middle-click (and, from
// 0.3.0, keyboard shortcuts) all run commands through applet._runAction(id, …),
// so each command is defined once. An entry holds:
//   label()      the menu text (a function so _() runs after gettext is bound)
//   icon         symbolic icon name for the menu row
//   perMonitor   true when the command acts on one monitor (run gets its name)
//   closesMenu   true when choosing the menu row closes the menu first
//   run(applet, monitorName, value)
//                value is the new state for switch rows (pause, carousel) and
//                undefined when the command should toggle.

const Utils = require('./modules/Utils');   // relative to the applet dir, as in applet.js
const _ = Utils._;

function currentImage(applet, monitorName) {
    let rec = applet._stateManager.getMonitorRecord(monitorName);
    return rec ? rec.currentImage : null;
}

var ACTIONS = {
    'next': {
        label: () => _('Next Wallpaper'), icon: 'go-next-symbolic',
        run: a => a._navigateNext(),
    },
    'previous': {
        label: () => _('Previous Wallpaper'), icon: 'go-previous-symbolic',
        run: a => a._navigatePrevious(),
    },
    'pause': {
        label: () => _('Pause Rotation'), icon: 'media-playback-pause-symbolic',
        run: (a, _m, value) => a._onPauseToggled(value === undefined ? !a._stateManager.isPaused() : !!value),
    },
    'swap': {
        label: () => _('Swap Images'), icon: 'object-flip-horizontal-symbolic', closesMenu: true,
        run: a => a._swapImages(),
    },
    'refresh-monitors': {
        label: () => _('Refresh Monitors'), icon: 'view-refresh-symbolic', closesMenu: true,
        run: a => a._refreshMonitors(),
    },
    'open-folder': {
        label: () => _('Open Image Folder'), icon: 'folder-open-symbolic',
        run: a => a._openCurrentFolder(),
    },
    'carousel': {
        label: () => _('Carousel'), icon: 'view-grid-symbolic', perMonitor: true, closesMenu: true,
        run: (a, m, value) => {
            let cm = a._carouselManager;
            if (!cm) return;
            let open = value === undefined ? !cm.isOpen(m) : !!value;
            if (!open) { cm.closeCarousel(m); return; }
            let mon = a._monitorManager.getMonitors().find(x => x.name === m);
            if (mon) cm.openCarousel(mon);
        },
    },
    'monitor-next': {
        label: () => _('Next Image'), icon: 'go-next-symbolic', perMonitor: true, closesMenu: true,
        run: (a, m) => a._changeMonitorWallpaper(m),
    },
    'monitor-previous': {
        label: () => _('Previous Image'), icon: 'go-previous-symbolic', perMonitor: true, closesMenu: true,
        run: (a, m) => a._navigateMonitorPrevious(m),
    },
    'monitor-pause': {
        label: () => _('Pause Rotation'), icon: 'media-playback-pause-symbolic', perMonitor: true,
        run: (a, m, value) => {
            a._stateManager.setMonitorPaused(m, value === undefined ? !a._stateManager.isMonitorPaused(m) : !!value);
            a._updateTooltip();
        },
    },
    'favorite': {
        label: () => _('Favorite This Image'), icon: 'non-starred-symbolic', perMonitor: true, closesMenu: true,
        run: (a, m) => a._toggleFavorite(m),
    },
    'trash': {
        label: () => _('Trash This Image'), icon: 'user-trash-symbolic', perMonitor: true, closesMenu: true,
        run: (a, m) => a._trashMonitorImage(m),
    },
    'open-viewer': {
        label: () => _('Open in Image Viewer'), icon: 'image-x-generic-symbolic', perMonitor: true, closesMenu: true,
        run: (a, m) => a._openImageInViewer(currentImage(a, m)),
    },
};

// Run a command. Unknown ids and per-monitor commands without a monitor are
// logged and ignored, never thrown: a stale shortcut must not break the applet.
var run = function(applet, id, monitorName, value) {
    let action = ACTIONS[id];
    if (!action) { Utils.warn('Unknown action "' + id + '"'); return false; }
    if (action.perMonitor && !monitorName) { Utils.warn('Action "' + id + '" needs a monitor'); return false; }
    action.run(applet, monitorName, value);
    return true;
};
