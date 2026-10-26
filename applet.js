const Applet = imports.ui.applet;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const Cinnamon = imports.gi.Cinnamon;
const DND = imports.ui.dnd;
const ByteArray = imports.byteArray;

// Separable box blur, run a couple of times it closely approximates a gaussian.
function blurPass(src, dst, w, h, stride, nch, r, horizontal) {
    const len = horizontal ? w : h;
    const lines = horizontal ? h : w;
    const step = horizontal ? nch : stride;
    const lineStep = horizontal ? stride : nch;
    for (let l = 0; l < lines; l++) {
        const base = l * lineStep;
        for (let i = 0; i < len; i++) {
            const lo = Math.max(0, i - r), hi = Math.min(len - 1, i + r);
            const count = hi - lo + 1;
            for (let ch = 0; ch < nch; ch++) {
                let sum = 0;
                for (let k = lo; k <= hi; k++) sum += src[base + k * step + ch];
                dst[base + i * step + ch] = sum / count;
            }
        }
    }
}

function gaussianApprox(data, w, h, stride, nch, radius, passes) {
    const tmp = new Uint8Array(data.length);
    for (let p = 0; p < passes; p++) {
        blurPass(data, tmp, w, h, stride, nch, radius, true);
        blurPass(tmp, data, w, h, stride, nch, radius, false);
    }
}

class LaunchpadApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.set_applet_tooltip('Launchie');

        this._overlay = null;
        this._entry = null;
        this._grid = null;
        this._dots = null;
        this._apps = [];
        this._filtered = [];
        this._page = 0;
        this._selected = -1;   // index into this._filtered, -1 = nothing selected
        this._cells = [];      // [{ btn, index }] for the visible page
        this._blurActor = null;
        this._blurCache = null;
        this._sliding = false;
        this._slideId = 0;
        this._cellCache = new Map();   // app id -> built cell (reused between pages)
        this._prewarmId = 0;
        this._lastScroll = 0;

        // Folders / drag & drop
        this._items = [];              // top-level items: apps and folders, in display order
        this._layout = { order: [], folders: {} };
        this._query = '';
        this._monitor = null;
        this._folderHolder = null;     // the open folder popup (if any)
        this._folderId = null;
        this._folderEntry = null;
        this._dragging = false;
        this._dragSource = null;
        this._dropAccepted = false;
        this._hoverCell = null;
        this._edgeTimer = 0;
        this._edgeDir = 0;
        this._loadLayout();
        this._hotkeyId = 'launchpad-' + instanceId;

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind('columns', 'columns', () => this._renderPage());
        this.settings.bind('rows', 'rows', () => this._renderPage());
        this.settings.bind('icon-size', 'iconSize', () => {
            this._clearCellCache();
            this._renderPage();
        });
        this.settings.bind('hotkey', 'hotkey', () => this._updateKeybinding());
        this.settings.bind('slide-animation', 'slideAnimation');
        this.settings.bind('enable-blur', 'enableBlur');
        this.settings.bind('blur-strength', 'blurStrength');
        this.settings.bind('dim-amount', 'dimAmount');
        this.settings.bind('panel-icon', 'panelIcon', () => this._updatePanelButton());
        this.settings.bind('panel-label', 'panelLabel', () => this._updatePanelButton());
        this.settings.bind('panel-icon-size', 'panelIconSize', () => this._updatePanelButton());
        this._updateKeybinding();
        this._updatePanelButton();
    }

    // ---------- applet lifecycle ----------

    on_applet_clicked() {
        this._toggle();
    }

    on_applet_removed_from_panel() {
        this._close(true);
        try { Main.keybindingManager.removeHotKey(this._hotkeyId); } catch (e) {}
        this.settings.finalize();
    }

    _updatePanelButton() {
        const icon = this.panelIcon || 'view-app-grid-symbolic';
        if (icon.startsWith('/'))
            this.set_applet_icon_path(icon);
        else if (icon.endsWith('-symbolic'))
            this.set_applet_icon_symbolic_name(icon);
        else
            this.set_applet_icon_name(icon);
        this.set_applet_label(this.panelLabel || '');
        this._applyPanelIconSize();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try { this._applyPanelIconSize(); } catch (e) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyPanelIconSize() {
        const icon = this._applet_icon;
        if (!icon) return;

        if (this.panelIconSize > 0) {
            const size = this.panelIconSize;
            // The theme's CSS can override the icon_size property, so set both
            // the property and an inline style (inline style wins over the theme).
            icon.set_icon_size(size);
            icon.set_style('icon-size: %dpx;'.format(size));
            global.log('Launchie: panel icon size set to ' + size);
        } else {
            // 0 = automatic: drop our override and let Cinnamon size it
            icon.set_style('');
            const auto = this.getPanelIconSize(icon.get_icon_type());
            if (auto > 0) icon.set_icon_size(auto);
        }
    }

    // Cinnamon re-styles the icon on its own (panel height change, icon swap);
    // re-apply our size afterwards so it doesn't get reset.
    _setStyle() {
        if (super._setStyle) super._setStyle();
        this._applyPanelIconSize();
    }

    on_panel_icon_size_changed() {
        this._applyPanelIconSize();
    }

    on_panel_height_changed() {
        if (super.on_panel_height_changed) super.on_panel_height_changed();
        this._applyPanelIconSize();
    }

    _updateKeybinding() {
        try { Main.keybindingManager.removeHotKey(this._hotkeyId); } catch (e) {}
        if (this.hotkey)
            Main.keybindingManager.addHotKey(this._hotkeyId, this.hotkey, () => this._toggle());
    }

    _toggle() {
        if (this._overlay) this._close();
        else this._open();
    }

    // ---------- data ----------

    _loadApps() {
        const seen = new Set();
        this._apps = Gio.AppInfo.get_all()
            .filter(a => a.should_show() && !seen.has(a.get_id()) && seen.add(a.get_id()))
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));
    }

    // ---------- layout (folders + order), saved in ~/.config/launchie/layout.json ----------

    _layoutPath() {
        return GLib.build_filenamev([GLib.get_user_config_dir(), 'launchie', 'layout.json']);
    }

    _loadLayout() {
        this._layout = { order: [], folders: {} };
        try {
            const [ok, bytes] = Gio.File.new_for_path(this._layoutPath()).load_contents(null);
            if (!ok) return;
            const d = JSON.parse(ByteArray.toString(bytes));
            if (d && Array.isArray(d.order))
                this._layout.order = d.order.filter(k => typeof k === 'string');
            if (d && d.folders && typeof d.folders === 'object') {
                for (const [id, f] of Object.entries(d.folders)) {
                    if (f && Array.isArray(f.apps))
                        this._layout.folders[id] = {
                            name: String(f.name || 'Folder'),
                            apps: f.apps.filter(a => typeof a === 'string'),
                        };
                }
            }
        } catch (e) {
            // First run or unreadable file: start from the default alphabetical layout
        }
    }

    _saveLayout() {
        try {
            const path = this._layoutPath();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            GLib.file_set_contents(path, JSON.stringify(this._layout));
        } catch (e) {
            global.logError('Launchie: could not save layout: ' + e);
        }
    }

    _itemKey(item) {
        return item.isFolder ? 'folder:' + item.id : (item.get_id() || item.get_name());
    }

    // Turns the saved layout + installed apps into the list shown on the grid.
    // Also repairs the layout: removes uninstalled apps, dissolves folders with
    // fewer than two apps, and appends newly installed apps at the end.
    _buildItems() {
        const L = this._layout;
        const byId = new Map(this._apps.map(a => [a.get_id(), a]));

        for (const [fid, f] of Object.entries(L.folders)) {
            f.apps = f.apps.filter(id => byId.has(id));
            if (f.apps.length >= 2) continue;
            const idx = L.order.indexOf('folder:' + fid);
            if (idx >= 0) {
                if (f.apps.length === 1) L.order.splice(idx, 1, f.apps[0]);
                else L.order.splice(idx, 1);
            }
            delete L.folders[fid];
        }

        const inFolder = new Set();
        for (const f of Object.values(L.folders)) f.apps.forEach(id => inFolder.add(id));

        const items = [], seen = new Set();
        const push = (key, item) => {
            if (seen.has(key)) return;
            seen.add(key);
            items.push(item);
        };
        const folderItem = fid => ({
            isFolder: true,
            id: fid,
            name: L.folders[fid].name,
            apps: L.folders[fid].apps.map(id => byId.get(id)),
        });

        for (const key of L.order) {
            if (key.startsWith('folder:')) {
                const fid = key.slice(7);
                if (L.folders[fid]) push(key, folderItem(fid));
            } else if (byId.has(key) && !inFolder.has(key)) {
                push(key, byId.get(key));
            }
        }
        for (const fid of Object.keys(L.folders)) push('folder:' + fid, folderItem(fid));
        for (const a of this._apps)
            if (!inFolder.has(a.get_id())) push(a.get_id(), a);

        L.order = items.map(i => this._itemKey(i));
        this._items = items;
    }

    _removeFromLayout(key) {
        const L = this._layout;
        L.order = L.order.filter(k => k !== key);
        for (const f of Object.values(L.folders))
            f.apps = f.apps.filter(id => id !== key);
    }

    // Put srcKey right before/after targetKey in the top-level order
    _moveItem(srcKey, targetKey, side) {
        if (srcKey === targetKey) return;
        this._removeFromLayout(srcKey);
        const order = this._layout.order;
        let idx = order.indexOf(targetKey);
        if (idx < 0) idx = order.length;
        else if (side === 'after') idx++;
        order.splice(idx, 0, srcKey);
    }

    // Drop an app onto another item: add to that folder, or make a new folder
    _mergeInto(srcKey, targetKey) {
        const L = this._layout;
        if (srcKey === targetKey || srcKey.startsWith('folder:')) return;
        if (targetKey.startsWith('folder:')) {
            const f = L.folders[targetKey.slice(7)];
            if (!f) return;
            this._removeFromLayout(srcKey);
            f.apps.push(srcKey);
        } else {
            const id = 'f' + Date.now().toString(36);
            this._removeFromLayout(srcKey);
            const at = L.order.indexOf(targetKey);
            L.folders[id] = { name: 'Folder', apps: [targetKey, srcKey] };
            if (at >= 0) L.order.splice(at, 1, 'folder:' + id);
            else L.order.push('folder:' + id);
        }
    }

    // Apply a layout change: rebuild items, save, and redraw
    _commitLayout() {
        this._buildItems();
        this._saveLayout();
        this._dropFolderCells();
        this._applyFilter(this._entry ? this._entry.get_text() : '');
        this._selected = -1;
        this._renderPage();
    }

    _dropFolderCells() {
        for (const [key, cell] of [...this._cellCache.entries()]) {
            if (!key.startsWith('folder:')) continue;
            this._cellCache.delete(key);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                try { cell.destroy(); } catch (e) {}
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _applyFilter(query) {
        const q = query.trim().toLowerCase();
        this._query = q;
        if (!q) {
            this._filtered = this._items;
            return;
        }
        const starts = [], contains = [];
        for (const a of this._apps) {
            const name = a.get_name().toLowerCase();
            if (name.startsWith(q)) starts.push(a);
            else if (name.includes(q) ||
                     (a.get_description() || '').toLowerCase().includes(q) ||
                     (a.get_generic_name() || '').toLowerCase().includes(q))
                contains.push(a);
        }
        this._filtered = starts.concat(contains);
    }

    // ---------- overlay ----------

    _open() {
        if (this._overlay) return;

        const mon = Main.layoutManager.currentMonitor || Main.layoutManager.primaryMonitor;
        this._loadApps();
        this._buildItems();
        this._monitor = mon;
        this._query = '';
        this._filtered = this._items;
        this._page = 0;
        this._selected = -1;
        this._sliding = false;
        this._slideId++;

        const o = this._overlay = new St.BoxLayout({
            style_class: 'launchpad-overlay',
            vertical: true,
            reactive: true,
            x: mon.x, y: mon.y,
            width: mon.width, height: mon.height,
            opacity: 0,
        });

        // Search bar
        this._entry = new St.Entry({
            style_class: 'launchpad-search',
            // Leading em space keeps the placeholder clear of the blinking text cursor
            hint_text: '\u2003Search',
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const ct = this._entry.clutter_text;
        ct.connect('text-changed', () => {
            this._closeFolder();
            const text = this._entry.get_text();
            this._applyFilter(text);
            this._page = 0;
            // While searching, the top result is pre-selected so Enter launches it
            this._selected = (text.trim() !== '' && this._filtered.length) ? 0 : -1;
            this._renderPage();
        });
        ct.connect('activate', () => {
            this._activateItem(this._filtered[this._selected]);
        });
        ct.connect('key-press-event', (a, ev) => this._onKey(ev));
        o.add_child(this._entry);

        // Grid
        this._grid = new St.BoxLayout({
            vertical: true,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            style: 'padding-top: 24px;',
        });
        // Without this, fading the grid renders it through an offscreen buffer
        // every frame, which is a big part of what makes slides feel sluggish.
        try {
            this._grid.set_offscreen_redirect(Clutter.OffscreenRedirect.NEVER);
        } catch (e) {}
        o.add_child(this._grid);

        // Page dots
        this._dots = new St.BoxLayout({
            style_class: 'launchpad-dots',
            x_align: Clutter.ActorAlign.CENTER,
        });
        o.add_child(this._dots);

        // Input handling
        o.connect('key-press-event', (a, ev) => this._onKey(ev));
        o.connect('scroll-event', (a, ev) => this._onScroll(ev));
        // Clicks that reach the overlay itself hit empty space -> close
        o.connect('button-press-event', () => {
            this._close();
            return Clutter.EVENT_STOP;
        });

        // Dropping onto empty space moves the dragged item to the end of this page.
        // Hovering near the left/right edge while dragging flips pages.
        o._delegate = {
            handleDragOver: () => {
                this._setDropHover(null);
                if (!this._dragSource || this._query) {
                    this._cancelEdgeTimer();
                    return DND.DragMotionResult.NO_DROP;
                }
                this._dragEdgeCheck();
                return DND.DragMotionResult.MOVE_DROP;
            },
            acceptDrop: () => {
                const src = this._dragSource;
                this._setDropHover(null);
                if (!src || this._query) return false;
                const per = this.columns * this.rows;
                const end = Math.min(this._items.length, (this._page + 1) * per);
                const last = this._items[end - 1];
                if (last) {
                    const key = this._itemKey(last);
                    if (key !== src.itemKey) this._moveItem(src.itemKey, key, 'after');
                }
                this._dropAccepted = true;
                this._commitLayout();
                return true;
            },
        };

        // Dim the background; the amount is configurable
        const alpha = Math.min(100, Math.max(0, this.dimAmount)) / 100;
        o.set_style('background-color: rgba(12, 12, 18, %s);'.format(alpha.toFixed(2)));

        // Blurred wallpaper goes in its own actor underneath the overlay
        const blur = this.enableBlur ? this._makeBlurActor(mon) : null;
        if (blur) {
            blur.opacity = 0;
            Main.layoutManager.addChrome(blur, { affectsStruts: false });
        }
        this._blurActor = blur;

        Main.layoutManager.addChrome(o, { affectsStruts: false });
        if (!Main.pushModal(o)) {
            Main.layoutManager.removeChrome(o);
            o.destroy();
            if (blur) {
                Main.layoutManager.removeChrome(blur);
                blur.destroy();
            }
            this._overlay = this._blurActor = null;
            return;
        }

        this._renderPage();
        o.ease({ opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        if (blur) blur.ease({ opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        ct.grab_key_focus();
    }

    _close(immediate = false) {
        const o = this._overlay;
        if (!o) return;
        this._closeFolder();
        this._cancelEdgeTimer();
        this._dragging = false;
        const blur = this._blurActor;
        const cache = this._cellCache;
        this._cellCache = new Map();
        this._prewarmId++;
        this._sliding = false;
        this._slideId++;
        this._overlay = this._entry = this._grid = this._dots = this._blurActor = null;

        Main.popModal(o);
        const cleanup = () => {
            Main.layoutManager.removeChrome(o);
            o.destroy();
            for (const cell of cache.values()) {
                try { cell.destroy(); } catch (e) {}
            }
            if (blur) {
                Main.layoutManager.removeChrome(blur);
                blur.destroy();
            }
        };
        if (immediate) {
            cleanup();
        } else {
            if (blur) blur.ease({
                opacity: 0, duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            o.ease({
                opacity: 0, duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: cleanup,
            });
        }
    }

    // ---------- blurred wallpaper ----------

    _makeBlurActor(mon) {
        try {
            const image = this._getBlurImage(mon);
            if (!image) return null;
            const actor = new Clutter.Actor({
                x: mon.x, y: mon.y,
                width: mon.width, height: mon.height,
                content: image,
                reactive: false,
            });
            actor.set_content_scaling_filters(Clutter.ScalingFilter.LINEAR,
                                              Clutter.ScalingFilter.LINEAR);
            return actor;
        } catch (e) {
            global.logError('Launchie: could not create blur: ' + e);
            return null;
        }
    }

    // Builds a heavily blurred copy of the current wallpaper (cached).
    // The wallpaper is cropped to the monitor's aspect ratio, shrunk to a tiny
    // image, smoothed with a gaussian-style blur, and then stretched back up
    // by the GPU with linear filtering, which gives a smooth, soft result.
    _getBlurImage(mon) {
        const GdkPixbuf = imports.gi.GdkPixbuf;
        const Cogl = imports.gi.Cogl;

        const bg = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.background' });
        if (bg.get_string('picture-options') === 'none') return null;
        const uri = bg.get_string('picture-uri');
        if (!uri) return null;
        const path = Gio.File.new_for_uri(uri).get_path();
        if (!path) return null;

        const strength = Math.min(10, Math.max(1, this.blurStrength));
        const key = '%s|%dx%d|%d'.format(path, mon.width, mon.height, strength);
        if (this._blurCache && this._blurCache.key === key)
            return this._blurCache.image;

        const full = GdkPixbuf.Pixbuf.new_from_file(path);
        const pw = full.get_width(), ph = full.get_height();
        const aspect = mon.width / mon.height;

        // Crop to the monitor's aspect ratio (like "zoom" wallpaper mode)
        let cw = pw, ch = ph;
        if (pw / ph > aspect) cw = Math.round(ph * aspect);
        else ch = Math.round(pw / aspect);
        const cx = Math.floor((pw - cw) / 2), cy = Math.floor((ph - ch) / 2);
        const cropped = full.new_subpixbuf(cx, cy, Math.max(1, cw), Math.max(1, ch));

        // Higher strength -> smaller intermediate image -> softer result
        const divisor = 6 + strength * 3;
        const tw = Math.max(16, Math.round(mon.width / divisor));
        const th = Math.max(9, Math.round(tw / aspect));
        const tiny = cropped.scale_simple(tw, th, GdkPixbuf.InterpType.BILINEAR);

        const nch = tiny.get_n_channels();
        const stride = tiny.get_rowstride();
        const data = Uint8Array.from(tiny.get_pixels());
        gaussianApprox(data, tw, th, stride, nch, 1, 2);
        if (nch === 4)
            for (let i = 3; i < data.length; i += 4) data[i] = 255;

        const image = new Clutter.Image();
        image.set_data(data,
                       nch === 4 ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                       tw, th, stride);

        this._blurCache = { key, image };
        return image;
    }

    // ---------- rendering ----------

    _pageCount() {
        const per = this.columns * this.rows;
        return Math.max(1, Math.ceil(this._filtered.length / per));
    }

    _renderPage() {
        if (!this._overlay) return;

        const cols = this.columns, rows = this.rows;
        const per = cols * rows;
        const pages = this._pageCount();
        this._page = Math.min(Math.max(this._page, 0), pages - 1);

        const slice = this._filtered.slice(this._page * per, (this._page + 1) * per);

        // Take cells back out of their rows (without destroying them) so they can
        // be reused; only the cheap row containers and spacers are thrown away.
        for (const row of this._grid.get_children()) {
            for (const child of row.get_children()) {
                if (child._isSpacer) child.destroy();
                else row.remove_child(child);
            }
        }
        this._grid.destroy_all_children();
        this._cells = [];
        if (this._selected >= this._filtered.length) this._selected = -1;
        for (let r = 0; r < rows; r++) {
            if (r * cols >= slice.length) break;
            const row = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c;
                // Pad incomplete rows with invisible cells so every row has
                // the same width and the columns always line up.
                row.add_child(idx < slice.length
                    ? this._getCell(slice[idx], this._page * per + idx)
                    : this._makeSpacer());
            }
            this._grid.add_child(row);
        }

        this._dots.destroy_all_children();
        if (pages > 1) {
            for (let p = 0; p < pages; p++) {
                const dot = new St.Button({ reactive: true, track_hover: true });
                const inner = new St.Bin({
                    style_class: 'launchpad-dot' + (p === this._page ? ' launchpad-dot-active' : ''),
                });
                dot.set_child(inner);
                dot.connect('clicked', () => this._goToPage(p));
                this._dots.add_child(dot);
            }
        }

        this._updateSelection();
        this._prewarm();
    }

    _updateSelection() {
        for (const { btn, index } of this._cells) {
            if (index === this._selected) btn.add_style_class_name('launchpad-cell-selected');
            else btn.remove_style_class_name('launchpad-cell-selected');
        }
    }

    _makeSpacer() {
        const spacer = new St.Bin({ style_class: 'launchpad-cell' });
        spacer._isSpacer = true;
        spacer.set_style('width: %dpx;'.format(Math.round(this.iconSize * 1.7)));
        return spacer;
    }

    _cellKey(item) {
        return this._itemKey(item);
    }

    _gicon(app) {
        return app.get_icon() || new Gio.ThemedIcon({ name: 'application-x-executable' });
    }

    _getCell(item, index) {
        const key = this._cellKey(item);
        let btn = this._cellCache.get(key);
        if (!btn) {
            btn = this._buildCell(item);
            this._cellCache.set(key, btn);
        }
        btn._index = index;   // position changes with search/paging, so keep it on the cell
        this._cells.push({ btn, index });
        return btn;
    }

    // 2x2 preview of the first four apps inside a rounded square
    _buildFolderIcon(folder, size) {
        const pad = 8, gap = 4;
        const mini = Math.max(12, Math.floor((size - 2 * pad - gap) / 2));
        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'launchpad-folder-icon',
            x_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: %dpx;'.format(gap),
        });
        const shown = folder.apps.slice(0, 4);
        for (let r = 0; r < 2; r++) {
            const row = new St.BoxLayout({ style: 'spacing: %dpx;'.format(gap) });
            for (let c = 0; c < 2; c++) {
                const app = shown[r * 2 + c];
                row.add_child(app
                    ? new St.Icon({ gicon: this._gicon(app), icon_size: mini })
                    : new St.Bin({ width: mini, height: mini }));
            }
            box.add_child(row);
        }
        return box;
    }

    // folderId is set for cells shown inside the folder popup
    _buildCell(item, folderId = null) {
        const size = this.iconSize;
        const btn = new St.Button({
            style_class: 'launchpad-cell',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        btn.set_style('width: %dpx;'.format(Math.round(size * 1.7)));

        const box = new St.BoxLayout({ vertical: true });
        const icon = item.isFolder
            ? this._buildFolderIcon(item, size)
            : new St.Icon({ gicon: this._gicon(item), icon_size: size });
        const label = new St.Label({
            text: item.isFolder ? item.name : item.get_name(),
            style_class: 'launchpad-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

        box.add_child(icon);
        box.add_child(label);
        btn.set_child(box);
        btn.connect('clicked', () => this._activateItem(item));

        if (folderId === null) {
            // Moving the mouse onto a cell moves the keyboard selection there too,
            // so there's only ever one highlighted app.
            btn.connect('motion-event', () => {
                if (this._selected !== btn._index) {
                    this._selected = btn._index;
                    this._updateSelection();
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        this._attachDrag(btn, item, folderId);
        return btn;
    }

    // Build the cells for the neighbouring pages in the background, a few at a
    // time, so flipping to them doesn't have to create icons mid-animation.
    _prewarm() {
        if (!this._overlay) return;
        const id = ++this._prewarmId;
        const per = this.columns * this.rows;
        const queue = [];
        for (const page of [this._page + 1, this._page - 1]) {
            if (page < 0) continue;
            for (const item of this._filtered.slice(page * per, (page + 1) * per))
                if (!this._cellCache.has(this._cellKey(item))) queue.push(item);
        }
        if (queue.length === 0) return;

        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (id !== this._prewarmId || !this._overlay) return GLib.SOURCE_REMOVE;
            for (let i = 0; i < 4 && queue.length; i++) {
                const item = queue.shift();
                const key = this._cellKey(item);
                if (!this._cellCache.has(key))
                    this._cellCache.set(key, this._buildCell(item));
            }
            return queue.length ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    // ---------- drag & drop ----------

    _attachDrag(btn, item, folderId) {
        const delegate = {
            cell: btn,
            item,
            itemKey: this._itemKey(item),
            isFolder: !!item.isFolder,
            folderId,
            getDragActor: () => {
                const sz = this.iconSize;
                return item.isFolder
                    ? this._buildFolderIcon(item, sz)
                    : new St.Icon({ gicon: this._gicon(item), icon_size: sz });
            },
            getDragActorSource: () => btn,
            handleDragOver: () => this._onCellDragOver(btn),
            acceptDrop: () => this._onCellDrop(btn),
        };
        btn._delegate = delegate;

        const draggable = DND.makeDraggable(btn);
        draggable.connect('drag-begin', () => this._onDragBegin(delegate));
        draggable.connect('drag-end', () => this._onDragEnd(delegate));
        btn._draggable = draggable;
    }

    _onDragBegin(delegate) {
        this._dragging = true;
        this._dragSource = delegate;
        this._dropAccepted = false;
        delegate.cell.add_style_class_name('launchpad-cell-dragging');
        // Dragging out of an open folder: hide the popup so the grid is reachable
        if (delegate.folderId !== null && this._folderHolder)
            this._folderHolder.hide();
    }

    _onDragEnd(delegate) {
        const accepted = this._dropAccepted;
        this._dragging = false;
        this._dragSource = null;
        this._dropAccepted = false;
        this._cancelEdgeTimer();
        this._setDropHover(null);
        try { delegate.cell.remove_style_class_name('launchpad-cell-dragging'); } catch (e) {}

        if (this._folderHolder) {
            if (accepted) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._closeFolder(true);
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._folderHolder.show();
            }
        }
    }

    // Where on the target cell the pointer is decides what a drop does:
    // left/right edges reorder, the middle stacks into a folder.
    _dropMode(btn, src) {
        const [px] = global.get_pointer();
        const [bx] = btn.get_transformed_position();
        const [bw] = btn.get_transformed_size();
        if (!(bw > 0)) return null;
        const rel = (px - bx) / bw;
        if (src.isFolder) return rel < 0.5 ? 'before' : 'after';
        if (rel < 0.28) return 'before';
        if (rel > 0.72) return 'after';
        return 'merge';
    }

    _canDropOn(btn, src) {
        const tgt = btn._delegate;
        return !!(src && tgt && !this._query && tgt.folderId === null &&
                  btn._index !== undefined && src.itemKey !== tgt.itemKey);
    }

    _onCellDragOver(btn) {
        const src = this._dragSource;
        if (!this._canDropOn(btn, src)) {
            this._setDropHover(null);
            this._cancelEdgeTimer();
            return DND.DragMotionResult.NO_DROP;
        }
        this._dragEdgeCheck();
        this._setDropHover(btn, this._dropMode(btn, src));
        return DND.DragMotionResult.MOVE_DROP;
    }

    _onCellDrop(btn) {
        const src = this._dragSource;
        const tgt = btn._delegate;
        const mode = this._canDropOn(btn, src) ? this._dropMode(btn, src) : null;
        this._setDropHover(null);
        if (!mode) return false;

        if (mode === 'merge') this._mergeInto(src.itemKey, tgt.itemKey);
        else this._moveItem(src.itemKey, tgt.itemKey, mode);

        this._dropAccepted = true;
        this._commitLayout();
        return true;
    }

    _setDropHover(btn, mode) {
        const classes = ['launchpad-drop-before', 'launchpad-drop-after', 'launchpad-drop-merge'];
        const prev = this._hoverCell;
        if (prev && prev !== btn) {
            try { for (const c of classes) prev.remove_style_class_name(c); } catch (e) {}
        }
        this._hoverCell = btn || null;
        if (!btn) return;
        for (const c of classes) btn.remove_style_class_name(c);
        if (mode) btn.add_style_class_name('launchpad-drop-' + mode);
    }

    // Hold a dragged item near the left/right screen edge to flip pages
    _dragEdgeCheck() {
        const m = this._monitor;
        if (!m) return;
        const [px] = global.get_pointer();
        const zone = 70;
        let dir = 0;
        if (px < m.x + zone) dir = -1;
        else if (px > m.x + m.width - zone) dir = 1;

        if (dir === 0) {
            this._cancelEdgeTimer();
            return;
        }
        if (this._edgeDir === dir && this._edgeTimer) return;

        this._cancelEdgeTimer();
        this._edgeDir = dir;
        this._edgeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._edgeTimer = 0;
            if (this._dragging && this._overlay) this._goToPage(this._page + dir);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelEdgeTimer() {
        if (this._edgeTimer) {
            GLib.source_remove(this._edgeTimer);
            this._edgeTimer = 0;
        }
        this._edgeDir = 0;
    }

    // ---------- folders ----------

    _activateItem(item) {
        if (!item) return;
        if (item.isFolder) this._openFolder(item.id);
        else this._launch(item);
    }

    _openFolder(id) {
        const folder = this._items.find(i => i.isFolder && i.id === id);
        if (!folder || !this._overlay) return;
        this._closeFolder();

        const mon = this._monitor;
        const holder = new St.BoxLayout({
            style_class: 'launchpad-folder-holder',
            reactive: true,
            x: mon.x, y: mon.y,
            width: mon.width, height: mon.height,
            opacity: 0,
        });
        const panel = new St.BoxLayout({
            style_class: 'launchpad-folder',
            vertical: true,
            reactive: true,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const nameEntry = new St.Entry({
            style_class: 'launchpad-folder-name',
            text: folder.name,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        panel.add_child(nameEntry);

        const cols = 4;
        const appsBox = new St.BoxLayout({ vertical: true, style: 'padding-top: 16px;' });
        for (let i = 0; i < folder.apps.length; i += cols) {
            const row = new St.BoxLayout({ x_align: Clutter.ActorAlign.START });
            for (const app of folder.apps.slice(i, i + cols))
                row.add_child(this._buildCell(app, id));
            appsBox.add_child(row);
        }
        panel.add_child(appsBox);
        holder.add_child(panel);

        // Click outside the panel closes it; clicks on the panel itself do nothing
        holder.connect('button-press-event', () => {
            this._closeFolder();
            return Clutter.EVENT_STOP;
        });
        panel.connect('button-press-event', () => Clutter.EVENT_STOP);

        const onKey = (a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                this._closeFolder();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        };
        holder.connect('key-press-event', onKey);
        nameEntry.clutter_text.connect('key-press-event', onKey);
        nameEntry.clutter_text.connect('activate', () => this._closeFolder());

        Main.layoutManager.addChrome(holder, { affectsStruts: false });
        holder.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        this._folderHolder = holder;
        this._folderId = id;
        this._folderEntry = nameEntry;
    }

    // skipRename: used after a drag-out, when the folder may no longer exist
    _closeFolder(skipRename = false) {
        const holder = this._folderHolder;
        if (!holder) return;
        const id = this._folderId, entry = this._folderEntry;
        this._folderHolder = this._folderEntry = null;
        this._folderId = null;

        let newName = null;
        if (!skipRename && entry) {
            const name = entry.get_text().trim() || 'Folder';
            const f = this._layout.folders[id];
            if (f && f.name !== name) newName = name;
        }

        try {
            Main.layoutManager.removeChrome(holder);
            holder.destroy();
        } catch (e) {}

        if (newName !== null) {
            this._layout.folders[id].name = newName;
            this._commitLayout();
        }
        if (this._entry) this._entry.clutter_text.grab_key_focus();
    }

    _clearCellCache() {
        for (const cell of this._cellCache.values()) {
            try { cell.destroy(); } catch (e) {}
        }
        this._cellCache.clear();
    }

    // ---------- actions ----------

    _launch(appInfo) {
        this._close();
        try {
            const app = Cinnamon.AppSystem.get_default().lookup_app(appInfo.get_id());
            if (app) app.open_new_window(-1);
            else appInfo.launch([], global.create_app_launch_context(0, -1));
        } catch (e) {
            global.logError('Launchie: failed to launch ' + appInfo.get_id() + ': ' + e);
        }
    }

    // Slide the grid out in the direction of travel, swap in the new page,
    // then slide it in from the opposite side. direction: +1 = next, -1 = previous.
    _renderPageAnimated(direction) {
        const grid = this._grid;
        if (!this.slideAnimation || !grid || !this._overlay || direction === 0) {
            this._renderPage();
            return;
        }

        const id = ++this._slideId;

        // Another page change while a slide is running: skip ahead to the final state
        if (this._sliding) {
            grid.remove_all_transitions();
            grid.translation_x = 0;
            grid.opacity = 255;
            this._sliding = false;
            this._renderPage();
            return;
        }

        this._sliding = true;
        const dist = Math.round(this._overlay.width * 0.08);

        grid.ease({
            translation_x: -direction * dist,
            opacity: 0,
            duration: 70,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (id !== this._slideId || this._grid !== grid) return;
                this._renderPage();
                grid.translation_x = direction * dist;
                grid.ease({
                    translation_x: 0,
                    opacity: 255,
                    duration: 130,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (id === this._slideId) this._sliding = false;
                    },
                });
            },
        });
    }

    _goToPage(page) {
        if (page < 0 || page >= this._pageCount()) return;
        const per = this.columns * this.rows;
        const direction = Math.sign(page - this._page);
        this._page = page;
        // Keep a selection (if any) on the new page: jump to its first app
        if (this._selected >= 0) this._selected = page * per;
        this._renderPageAnimated(direction);
    }

    _changePage(delta) {
        this._goToPage(this._page + delta);
    }

    _select(index) {
        const n = this._filtered.length;
        if (n === 0) return;
        index = Math.max(0, Math.min(n - 1, index));
        const per = this.columns * this.rows;
        const page = Math.floor(index / per);
        const direction = Math.sign(page - this._page);
        this._selected = index;
        if (page !== this._page) {
            this._page = page;
            this._renderPageAnimated(direction);
        } else {
            this._updateSelection();
        }
    }

    _moveSelection(direction) {
        const n = this._filtered.length;
        if (n === 0) return;
        // First key press just selects the first app
        if (this._selected < 0) {
            this._select(0);
            return;
        }
        const cols = this.columns;
        const cur = this._selected;
        let next = cur;
        switch (direction) {
            case 'left':  next = cur - 1; break;
            case 'right': next = cur + 1; break;
            case 'up':    next = cur - cols; break;
            case 'down':
                next = cur + cols;
                // Short last row: go to its last app instead of doing nothing
                if (next >= n && Math.floor(cur / cols) < Math.floor((n - 1) / cols))
                    next = n - 1;
                break;
        }
        if (next < 0 || next >= n) return;
        this._select(next);
    }

    _onKey(ev) {
        const sym = ev.get_key_symbol();
        const emptySearch = !this._entry || this._entry.get_text() === '';

        // While a folder is open, Esc closes it first and navigation keys are ignored
        if (this._folderHolder) {
            if (sym === Clutter.KEY_Escape) {
                this._closeFolder();
                return Clutter.EVENT_STOP;
            }
            if ([Clutter.KEY_Page_Down, Clutter.KEY_Page_Up, Clutter.KEY_Down, Clutter.KEY_Up,
                 Clutter.KEY_Left, Clutter.KEY_Right, Clutter.KEY_Tab,
                 Clutter.KEY_ISO_Left_Tab].includes(sym))
                return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Escape) {
            this._close();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Page_Down) {
            this._changePage(1);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Page_Up) {
            this._changePage(-1);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Down) {
            this._moveSelection('down');
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Up) {
            this._moveSelection('up');
            return Clutter.EVENT_STOP;
        }
        // Left/Right move the text cursor while typing, and the selection otherwise
        if (emptySearch && sym === Clutter.KEY_Right) {
            this._moveSelection('right');
            return Clutter.EVENT_STOP;
        }
        if (emptySearch && sym === Clutter.KEY_Left) {
            this._moveSelection('left');
            return Clutter.EVENT_STOP;
        }
        // Tab / Shift+Tab always move the selection, even with text in the search box
        if (sym === Clutter.KEY_Tab) {
            this._moveSelection('right');
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_ISO_Left_Tab) {
            this._moveSelection('left');
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onScroll(ev) {
        // Throttle so a touchpad flick doesn't skip many pages
        const now = Date.now();
        if (now - this._lastScroll < 250) return Clutter.EVENT_STOP;

        const dir = ev.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            this._changePage(1);
        else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            this._changePage(-1);
        else
            return Clutter.EVENT_PROPAGATE;

        this._lastScroll = now;
        return Clutter.EVENT_STOP;
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new LaunchpadApplet(metadata, orientation, panelHeight, instanceId);
}
