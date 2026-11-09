// Rotation.js (0.2.3): which image goes on which monitor — Sync vs independent,
// paused / disabled monitors carried forward, empty-pool fallback, per-monitor
// and global history, swap, and the changed-monitor list behind notifications.
// Pure module: plain data in, plain data out.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);
const R = require('./modules/Rotation');

const MONS = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];

// view over: current images, disabled monitors, paused monitors, files that are gone.
function view(o) {
    o = o || {};
    const current  = Object.assign({ A: '/w/a.jpg', B: '/w/b.jpg', C: '/w/c.jpg' }, o.current || {});
    const disabled = new Set(o.disabled || []);
    const paused   = new Set(o.paused || []);
    const gone     = new Set(o.gone || []);
    return {
        slot:     n => ({ enabled: !disabled.has(n), scaling: (o.scaling || {})[n] || 'zoom', folder: '/w' }),
        current:  n => current[n] || null,
        isPaused: n => paused.has(n),
        exists:   p => !gone.has(p),
    };
}
function pool(list) {
    let i = 0;
    return { next: () => (i < list.length ? list[i++] : null), getCount: () => list.length };
}
// T.eq compares JSON text, so key order matters: compare maps with sorted keys.
const canon = o => Object.fromEntries(Object.entries(o).sort());
const paths = asg => canon(Object.fromEntries(Object.entries(asg).map(([k, v]) => [k, v.path])));

T.run('assignment carries the monitor\'s scaling', () => {
    T.eq(R.assignment(view({ scaling: { B: 'fit' } }), 'B', '/x.jpg'), { path: '/x.jpg', scaling: 'fit' });
});

T.run('independent: each enabled, unpaused monitor advances from its own pool', () => {
    const pools = new Map([['A', pool(['/p/a1.jpg'])], ['B', pool(['/p/b1.jpg'])], ['C', pool(['/p/c1.jpg'])]]);
    const plan = R.advance(view(), MONS, { sync: false, pools });
    T.eq(plan.monitorImages, { A: '/p/a1.jpg', B: '/p/b1.jpg', C: '/p/c1.jpg' });
    T.eq(paths(plan.assignments), canon(plan.monitorImages));
});

T.run('independent: paused and disabled monitors keep their image but are not a change', () => {
    const pools = new Map([['A', pool(['/p/a1.jpg'])], ['B', pool(['/p/b1.jpg'])], ['C', pool(['/p/c1.jpg'])]]);
    const plan = R.advance(view({ paused: ['B'], disabled: ['C'] }), MONS, { sync: false, pools });
    T.eq(plan.monitorImages, { A: '/p/a1.jpg' }, 'only A changes');
    T.eq(paths(plan.assignments), { A: '/p/a1.jpg', B: '/w/b.jpg', C: '/w/c.jpg' }, 'B and C carried forward');
});

T.run('independent: an empty pool falls back to the current image', () => {
    const pools = new Map([['A', pool([])], ['B', pool(['/p/b1.jpg'])]]);
    const plan = R.advance(view(), MONS.slice(0, 2), { sync: false, pools });
    T.eq(plan.monitorImages, { A: '/w/a.jpg', B: '/p/b1.jpg' });
});

T.run('independent: nothing eligible / no images at all → skip with a reason', () => {
    T.eq(R.advance(view({ paused: ['A', 'B', 'C'] }), MONS, { sync: false, pools: new Map() }), { skip: 'no-eligible' });
    T.eq(R.advance(view({ current: { A: null } }), [MONS[0]], { sync: false, pools: new Map() }), { skip: 'no-images' });
});

T.run('Sync: every enabled monitor gets the one image; disabled ones are left out', () => {
    const plan = R.advance(view({ disabled: ['C'], paused: ['A'] }), MONS, { sync: true, syncPool: pool(['/s/1.jpg']) });
    T.eq(plan.monitorImages, { A: '/s/1.jpg', B: '/s/1.jpg' }, 'per-monitor pause does not apply in Sync');
    T.ok(!('C' in plan.assignments), 'disabled monitor not carried forward in Sync (as in 0.2.2)');
    T.eq(R.advance(view(), MONS, { sync: true, syncPool: pool([]) }), { skip: 'sync-empty' });
    T.eq(R.advance(view(), MONS, { sync: true, syncPool: null }), { skip: 'sync-empty' });
    T.eq(R.advance(view({ disabled: ['A', 'B', 'C'] }), MONS, { sync: true, syncPool: pool(['/s/1.jpg']) }), { skip: 'no-eligible' });
});

T.run('applyImage: one monitor changes, the others are recorded unchanged', () => {
    const plan = R.applyImage(view(), MONS, 'B', '/n.jpg', false);
    T.eq(canon(plan.monitorImages), { A: '/w/a.jpg', B: '/n.jpg', C: '/w/c.jpg' });
    T.eq(paths(plan.assignments), canon(plan.monitorImages));
});

T.run('applyImage in Sync: every enabled monitor gets the image', () => {
    const plan = R.applyImage(view({ disabled: ['C'] }), MONS, 'A', '/n.jpg', true);
    T.eq(canon(plan.monitorImages), { A: '/n.jpg', B: '/n.jpg', C: '/w/c.jpg' });
    const none = R.applyImage(view({ disabled: ['A', 'B', 'C'] }), MONS, 'A', '/n.jpg', true);
    T.eq(none.monitorImages.A, '/n.jpg', 'no enabled monitor: the clicked one still gets it');
});

T.run('monitorPrevious: newest differing image that still exists', () => {
    const hist = [
        { monitors: { A: '/w/a.jpg', B: '/h/b3.jpg' } },   // 1 step back
        { monitors: { A: '/h/a2.jpg', B: '/h/b2.jpg' } },  // 2
        { monitors: { A: '/h/a1.jpg' } },                  // 3
    ];
    const history = { length: hist.length, at: i => hist[i - 1] || null };
    T.eq(R.monitorPrevious(view(), 'A', history), '/h/a2.jpg', 'skips the entry equal to the current image');
    T.eq(R.monitorPrevious(view({ gone: ['/h/a2.jpg'] }), 'A', history), '/h/a1.jpg', 'skips a deleted file');
    T.eq(R.monitorPrevious(view(), 'C', history), null, 'no entry for C');
    T.eq(R.monitorPrevious(view(), 'A', { length: 0, at: () => null }), null, 'empty history');
});

T.run('historyStep: back, forward to the tip, and advancing from the tip', () => {
    const hist = ['tip-1', 'tip-2'];
    const at = i => (hist[i - 1] ? { monitors: {}, id: hist[i - 1] } : null);
    T.eq(R.historyStep(0, 'back', at).position, 1);
    T.eq(R.historyStep(0, 'back', at).entry.id, 'tip-1');
    T.eq(R.historyStep(1, 'back', at).entry.id, 'tip-2');
    T.eq(R.historyStep(2, 'back', at), null, 'nothing older');
    T.eq(R.historyStep(0, 'forward', at), { position: 0, kind: 'advance' });
    T.eq(R.historyStep(1, 'forward', at), { position: 0, kind: 'restore' });
    const two = R.historyStep(2, 'forward', at);
    T.eq([two.position, two.kind, two.entry.id], [1, 'entry', 'tip-1']);
});

T.run('fromHistory and restore skip files that are gone', () => {
    const entry = { monitors: { A: '/h/a.jpg', B: '/h/b.jpg' } };
    T.eq(paths(R.fromHistory(view({ gone: ['/h/b.jpg'] }), MONS, entry)), { A: '/h/a.jpg' });
    T.eq(paths(R.restore(view({ gone: ['/w/c.jpg'], current: { B: null } }), MONS)), { A: '/w/a.jpg' });
});

T.run('swap: rotate left across monitors that have an image', () => {
    T.eq(R.swap(view(), [MONS[0]]), null, 'one monitor: nothing to swap');
    T.eq(R.swap(view({ current: { B: null } }), MONS.slice(0, 2)), null, 'only one with an image');
    T.eq(canon(R.swap(view(), MONS.slice(0, 2)).monitorImages), { A: '/w/b.jpg', B: '/w/a.jpg' }, 'A↔B');
    T.eq(canon(R.swap(view(), MONS).monitorImages), { A: '/w/b.jpg', B: '/w/c.jpg', C: '/w/a.jpg' }, 'A→B→C→A');
    const gap = R.swap(view({ current: { B: null } }), MONS);
    T.eq(canon(gap.monitorImages), { A: '/w/c.jpg', C: '/w/a.jpg' }, 'a monitor without an image sits out');
});

T.run('changedMonitors: only monitors whose image differs from the saved one', () => {
    const changed = R.changedMonitors(view({ current: { C: null } }), MONS, { A: '/w/a.jpg', B: '/n.jpg', C: '/n.jpg' });
    T.eq(changed.map(m => m.name), ['B', 'C']);
});

T.exit();
