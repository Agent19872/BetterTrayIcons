import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {warn, error} from '../shared/logging.js';
import {formatAppName, getAppConfigMap, updateAppConfig} from '../shared/appConfig.js';
import {readDirNames, readFileBytes} from '../shared/fetch.js';
import {clearIds, disconnectSignal, disconnectAll, disposeAll, removeTimer} from '../shared/lifecycle.js';
import {
    isDragEnabledFromSettings,
    setupIconDragSource,
    forwardDragStateToIndicator,
} from './features/dragAndDrop.js';
import {Tooltip} from './features/tooltip.js';
import {computeTrayIconStyle} from './utils/actor.js';
import {
    DRAG_SETTING_KEYS,
    DRAGGING_SOURCE_OPACITY,
    GENERIC_UMU_GAME_IDS,
    PLACEHOLDER_WMCLASS_RE,
    PROC_WALK_MAX_DEPTH,
    STEAM_APP_WMCLASS_RE,
    WINE_LAUNCHER_BINARIES,
    WINE_LAUNCHER_ENV_KEYS,
    XEMBED_STYLE_KEYS,
    XEMBED_BG_FALLBACK_HEX,
} from '../const.js';

export class XEmbedTrayBridge {
    constructor(settings, panelIndicator) {
        this._settings = settings;
        this._panelIndicator = panelIndicator;
        this._tray = null;
        this._wrappers = new Map();
        // rawIcon → Gio.Cancellable for in-flight XEmbedTrayIcon.create calls.
        // Lets _onIconRemoved and _stop abort meta resolution mid-flight.
        this._pendingCreates = new Map();
        this._traySignals = [];
        this._bgSignalIds = [];
        this._enableSignalId = 0;
        this._lastBgCss = null;
    }

    enable() {
        this._enableSignalId = this._settings.connect(
            'changed::enable-wine-support', () => this._sync());
        this._sync();
    }

    // Toggling the setting only flips wrapper visibility. unmanage_screen()
    // would force every Wine client to drop its tray icon, and most Wine
    // builds don't re-register on the MANAGER ClientMessage when reclaimed.
    _sync() {
        const enabled = this._settings.get_boolean('enable-wine-support');
        if (enabled && !this._tray)
            this._start();
        for (const wrapper of this._wrappers.values()) {
            if (wrapper.actor)
                wrapper.actor.visible = enabled;
        }
    }

    _start() {
        if (this._tray)
            return;

        try {
            this._tray = new Shell.TrayManager({bgColor: this._resolveBgColor()});
        } catch (e) {
            error('XEmbedTrayBridge: failed to construct Shell.TrayManager', e);
            return;
        }

        this._traySignals.push(this._tray.connect('tray-icon-added',
            (_t, icon) => this._onIconAdded(icon)));
        this._traySignals.push(this._tray.connect('tray-icon-removed',
            (_t, icon) => this._onIconRemoved(icon)));

        // manage_screen claims the X11 system-tray selection. Fails if
        // another tray is already running.
        try {
            this._tray.manage_screen(Main.panel);
        } catch (e) {
            warn(`XEmbedTrayBridge: manage_screen failed: ${e.message}`);
        }

        // bgColor is baked into each XEmbed child at construct time, so the
        // TrayManager has to be rebuilt on a color change.
        this._bgSignalIds = [
            this._settings.connect('changed::overflow-container-background-color',
                () => this._rebuildIfBgColorChanged()),
            this._settings.connect('changed::enable-custom-overflow-style',
                () => this._rebuildIfBgColorChanged()),
        ];
        this._lastBgCss = this._preferredBgCss();
    }

    _rebuildIfBgColorChanged() {
        if (!this._tray)
            return;
        const next = this._preferredBgCss();
        if (next === this._lastBgCss)
            return;
        this._lastBgCss = next;
        this._stop();
        this._start();
    }

    _resolveBgColor() {
        const css = this._preferredBgCss();
        return parseCssColor(css) ?? getFallbackBgColor();
    }

    _preferredBgCss() {
        if (this._settings.get_boolean('enable-custom-overflow-style')) {
            const css = this._settings.get_string('overflow-container-background-color');
            if (css?.trim().length > 0)
                return css;
        }
        return XEMBED_BG_FALLBACK_HEX;
    }

    _stop() {
        if (!this._tray)
            return;

        // Abort any in-flight wrapper creations so their awaits short-circuit
        // before they try to touch torn-down state.
        for (const cancellable of this._pendingCreates.values())
            cancellable.cancel();
        this._pendingCreates.clear();

        disconnectAll(this, this._settings, '_bgSignalIds');

        // Disconnect first. Otherwise wrapper teardown below triggers
        // tray-icon-removed events that we'd have to ignore.
        disconnectAll(this, this._tray, '_traySignals');

        for (const wrapper of this._wrappers.values())
            wrapper.destroy();
        this._wrappers.clear();

        this._tray.unmanage_screen();
        this._tray = null;
    }

    async _onIconAdded(rawIcon) {
        if (!rawIcon || this._wrappers.has(rawIcon) || this._pendingCreates.has(rawIcon))
            return;

        const cancellable = new Gio.Cancellable();
        this._pendingCreates.set(rawIcon, cancellable);

        let wrapper;
        try {
            wrapper = await XEmbedTrayIcon.create(
                rawIcon,
                this._settings,
                id => this._afterWrapperDestroyed(rawIcon, id),
                () => this._panelIndicator?._handleIconClick?.(),
                forwardDragStateToIndicator(this._panelIndicator),
                cancellable
            );
        } catch (e) {
            if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                warn(`XEmbedTrayBridge: wrapper create failed: ${e.message}`);
            return;
        } finally {
            this._pendingCreates.delete(rawIcon);
        }

        // Bridge state may have changed during async meta resolution: the bridge
        // could have been stopped, or a removed→added cycle could have raced past us.
        // Drop the wrapper instead of attaching it.
        if (cancellable.is_cancelled() || !this._tray || this._wrappers.has(rawIcon)) {
            wrapper.destroy();
            return;
        }

        this._wrappers.set(rawIcon, wrapper);
        wrapper.actor.visible = this._settings.get_boolean('enable-wine-support');
        this._panelIndicator.addIcon(wrapper.id, wrapper.actor);
    }

    _onIconRemoved(rawIcon) {
        const cancellable = this._pendingCreates.get(rawIcon);
        if (cancellable) {
            cancellable.cancel();
            this._pendingCreates.delete(rawIcon);
        }
        this._wrappers.get(rawIcon)?.destroy();
    }

    _afterWrapperDestroyed(rawIcon, wrapperId) {
        this._wrappers.delete(rawIcon);
        this._panelIndicator.removeIcon(wrapperId);
    }

    disable() {
        disconnectSignal(this, this._settings, '_enableSignalId');
        this._stop();
        _manifestNameCache.clear();
    }
}

// Distinguishes wrappers whose appId and pid both collide: one explorer.exe
// owns every tray window of a prefix, so two apps there look identical.
let _wrapperSerial = 0;

class XEmbedTrayIcon {
    // Two-step construction: meta resolution awaits async /proc and Steam
    // manifest reads, then the synchronous constructor wires up the actor.
    static async create(rawIcon, settings, onDestroy, onAfterClick, onDragStateChange = null, cancellable = null) {
        const meta = await deriveAppMeta(rawIcon, cancellable);
        return new XEmbedTrayIcon(rawIcon, meta, settings, onDestroy, onAfterClick, onDragStateChange);
    }

    constructor(rawIcon, meta, settings, onDestroy, onAfterClick, onDragStateChange = null) {
        this._icon = rawIcon;
        this._settings = settings;
        this._onDestroy = onDestroy;
        this._onAfterClick = onAfterClick;
        this._onDragStateChange = onDragStateChange;
        this._isDestroyed = false;
        this._baseStyle = '';
        this._hoverStyle = '';
        this._pendingClickId = 0;
        this._actorSignals = [];
        this._settingsSignals = [];
        this._draggable = null;
        this._tooltip = null;

        this.appId = meta.appId;
        // pid separates instances across prefixes, the serial separates apps
        // within one prefix, where every icon reports explorer's pid.
        this.id = `xembed:${this.appId}:${rawIcon.pid || 0}:${++_wrapperSerial}`;

        this.actor = new St.Bin({
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_expand: true,
            x_expand: false,
            y_align: Clutter.ActorAlign.FILL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor._appId = this.appId;
        this.actor.set_child(rawIcon);

        try {
            this._tooltip = new Tooltip(this.actor, this._settings);
        } catch (e) {
            warn(`XEmbedTrayIcon: Failed to create tooltip for ${this.id}: ${e.message}`);
        }

        this._applyIconSize();
        this._updateStyle();
        this._connectSignals();
        this._setupDrag();

        updateAppConfig(settings, this.appId, {
            title: meta.title || this.appId,
            is_wine: meta.isWine,
            is_proton: meta.isProton,
        });
        this._updateTitle();
    }

    _connectSignals() {
        // XEmbed icons own their click semantics, so bypass ClickController
        // and forward directly through Shell.TrayIcon.click().
        this._actorSignals.push(
            this.actor.connect('button-press-event', () => {
                this.actor.add_style_pseudo_class('active');
                return Clutter.EVENT_PROPAGATE;
            }),
            this.actor.connect('button-release-event', (_a, event) => {
                this.actor.remove_style_pseudo_class('active');
                const isRightClick = event.get_button() === 3;
                this._forwardClick(event, isRightClick);
                this._onAfterClick?.();
                return Clutter.EVENT_PROPAGATE;
            }),
            this.actor.connect('leave-event', () => {
                this.actor.remove_style_pseudo_class('active');
                this._updateHoverState();
                return Clutter.EVENT_PROPAGATE;
            }),
            this.actor.connect('notify::hover', () => {
                this._updateHoverState();
                this._syncTooltip();
            })
        );

        this._sigIconDestroy = this._icon.connect('destroy', () => {
            this._sigIconDestroy = 0;
            this.destroy();
        });

        this._settingsSignals.push(this._settings.connect('changed::icon-size', () => {
            this._applyIconSize();
            this._updateStyle();
        }));
        for (const key of XEMBED_STYLE_KEYS) {
            this._settingsSignals.push(this._settings.connect(`changed::${key}`,
                () => this._updateStyle()));
        }

        // Renames from the prefs dialog land in app-configs.
        this._settingsSignals.push(
            this._settings.connect('changed::app-configs', () => this._updateTitle()),
            this._settings.connect('changed::enable-tooltips', () => this._updateTitle())
        );
    }

    _setupDrag() {
        this._draggable = setupIconDragSource({
            actor: this.actor,
            appId: this.appId,
            settings: this._settings,
            label: this.id,
            onLocalDragStateChange: isDragging => {
                if (this._isDestroyed || !this.actor)
                    return;
                this.actor.opacity = isDragging ? DRAGGING_SOURCE_OPACITY : 255;
                // Same stuck-tooltip trap as the SNI wrapper: hover doesn't
                // re-fire after a drag ends with the pointer still on the icon.
                if (this._tooltip)
                    this._tooltip.hide();
            },
            onForwardedDragStateChange: this._onDragStateChange,
        });

        for (const key of DRAG_SETTING_KEYS) {
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, () => {
                this._draggable?.setEnabled(isDragEnabledFromSettings(this._settings));
            }));
        }
    }

    // Right click goes through GLib.idle_add so Mutter has released its
    // implicit grabs before Wine raises its context menu. This only
    // mitigates the click-race on X11, not the XWayland XGrabPointer issue.
    _forwardClick(event, isRightClick) {
        if (!isRightClick) {
            this._icon.click(event);
            return;
        }
        // Clutter recycles event objects, so copy before deferring.
        const eventCopy = event.copy() ?? event;
        this._pendingClickId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pendingClickId = 0;
            if (!this._isDestroyed && this._icon)
                this._icon.click(eventCopy);
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyIconSize() {
        const size = this._settings.get_int('icon-size') || 20;
        this._icon.set({
            width: size,
            height: size,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    // The X11 icon is opaque.
    // Background-color only shows in the padding, which forms the hover halo.
    _updateStyle() {
        if (this._isDestroyed)
            return;

        const {enableCustom, baseStyle, hoverStyle} = computeTrayIconStyle(this._settings, {withColors: false});
        if (enableCustom)
            this.actor.remove_style_class_name('panel-button');
        else
            this.actor.add_style_class_name('panel-button');

        this._baseStyle = baseStyle;
        this._hoverStyle = hoverStyle;
        this._updateHoverState();
    }

    _updateHoverState() {
        if (this._isDestroyed)
            return;
        this.actor.set_style(this.actor.hover ? this._hoverStyle : this._baseStyle);
    }

    _syncTooltip() {
        if (!this._tooltip)
            return;
        if (this.actor.hover && this._settings.get_boolean('enable-tooltips'))
            this._tooltip.trigger();
        else
            this._tooltip.hide();
    }

    // XEmbed has no tooltip protocol and Wine leaves the icon window's
    // WM_NAME empty, so the tooltip falls back to the resolved app name.
    _updateTitle() {
        if (this._isDestroyed)
            return;
        const config = getAppConfigMap(this._settings)[this.appId] ?? {};
        const title = config.custom_title || formatAppName(config.title || this.appId);
        const showTooltip = this._settings.get_boolean('enable-tooltips');
        this.actor.accessible_name = showTooltip ? title : '';
        if (this._tooltip)
            this._tooltip.text = title;
    }

    destroy() {
        if (this._isDestroyed)
            return;
        this._isDestroyed = true;

        disposeAll(this, 'destroy', '_draggable', '_tooltip');
        clearIds(this, removeTimer, '_pendingClickId');
        disconnectAll(this, this._settings, '_settingsSignals');
        disconnectAll(this, this.actor, '_actorSignals');
        disconnectSignal(this, this._icon, '_sigIconDestroy');

        this._onDestroy?.(this.id);

        this.actor.destroy();
        this.actor = null;
        this._icon = null;
    }
}

async function deriveAppMeta(rawIcon, cancellable) {
    const wmClass = (rawIcon.wm_class || '').toString().trim();
    const cleanWmClass = wmClass.replace(/\.exe$/i, '');
    const xTitle = (rawIcon.title || '').toString().trim();
    const id = await gatherWineIdentity(rawIcon, cancellable);

    const wmGeneric = STEAM_APP_WMCLASS_RE.test(wmClass);
    const wmPlaceholder = PLACEHOLDER_WMCLASS_RE.test(wmClass);
    const looksLikeExe = /\.exe$/i.test(wmClass);
    const isWine = id.isWine || looksLikeExe;
    const isProton = id.isProton || wmGeneric;

    // Identifier preference: Steam appid > launcher/prefix name > wm_class >
    // X11 title > pid. wm_class beats X11 title because it stays stable across
    // restarts, but a placeholder class naming the Wine build instead of the
    // app loses to the launcher or prefix name.
    let candidate;
    let title;
    if (id.steamAppId) {
        candidate = `steam-app-${id.steamAppId}`;
        title = await steamAppNameFromManifest(id.steamAppId, cancellable) || cleanWmClass || xTitle;
    } else if (id.prefixId && (wmPlaceholder || !cleanWmClass)) {
        candidate = id.prefixId;
        title = id.launcherName || xTitle || id.prefixId;
    } else if (cleanWmClass) {
        candidate = cleanWmClass;
        title = wmPlaceholder ? xTitle || cleanWmClass : cleanWmClass;
    } else {
        candidate = xTitle;
        title = xTitle;
    }

    const appId = sanitizeId(candidate) || `xembed-${rawIcon.pid || 'unknown'}`;
    return {appId, isWine, isProton, steamAppId: id.steamAppId, title};
}

// Environ is inherited across fork(), so walking up the parent chain reaches
// the Proton launcher even when the tray icon was registered by a wineserver
// helper several levels deep.
async function gatherWineIdentity(rawIcon, cancellable) {
    const identity = newIdentity();

    let pid = rawIcon.pid || 0;
    /* eslint-disable no-await-in-loop */
    for (let depth = 0; depth < PROC_WALK_MAX_DEPTH && pid && pid !== 1; depth++) {
        mergeEnvIdentity(identity, await readEnviron(pid, cancellable));

        const exeBase = await exeBaseFromCmdline(pid, cancellable);
        if (exeBase && WINE_LAUNCHER_BINARIES.has(exeBase))
            identity.isWine = true;

        if (identity.steamAppId || identity.prefixId)
            break;
        pid = await readPpid(pid, cancellable);
    }
    /* eslint-enable no-await-in-loop */

    // Pressure-vessel runs Wine in its own pid namespace, so the pid X11
    // reports doesn't exist on the host and the walk above sees nothing.
    if (!identity.isWine && !identity.steamAppId && !identity.prefixId)
        await adoptNamespacedIdentity(identity, rawIcon.pid || 0, cancellable);

    return identity;
}

function newIdentity() {
    return {isWine: false, isProton: false, steamAppId: null, prefixId: null, launcherName: null};
}

function mergeEnvIdentity(identity, env) {
    if (!env.size)
        return;
    if (env.has('STEAM_COMPAT_DATA_PATH') ||
        env.has('PROTON_LOG') ||
        env.has('STEAM_COMPAT_CLIENT_INSTALL_PATH')) {
        identity.isProton = true;
        identity.isWine = true;
    }
    if (env.has('WINEPREFIX') || env.has('WINELOADER') || env.has('WINESERVER'))
        identity.isWine = true;
    identity.steamAppId ??= steamAppIdFromEnviron(env);
    identity.launcherName ??= launcherNameFromEnviron(env);
    identity.prefixId ??= prefixIdFromEnviron(env);
}

// Two containers can hand out the same namespaced pid, so the identity is
// only adopted when all Wine matches agree on one app.
async function adoptNamespacedIdentity(identity, nsPid, cancellable) {
    if (!nsPid)
        return;

    const hostPids = await hostPidsForNsPid(nsPid);
    const envs = await Promise.all(hostPids.map(pid => readEnviron(pid, cancellable)));

    const probes = [];
    for (const env of envs) {
        const probe = newIdentity();
        mergeEnvIdentity(probe, env);
        if (probe.isWine)
            probes.push(probe);
    }

    // The flags survive an ambiguous match, every candidate is a Wine
    // process, so the icon is one too. Only the app identity needs to
    // be unique.
    for (const probe of probes) {
        identity.isWine ||= probe.isWine;
        identity.isProton ||= probe.isProton;
    }

    const ids = new Set(probes.map(p => p.steamAppId ?? p.prefixId).filter(Boolean));
    if (ids.size > 1)
        return;

    for (const probe of probes) {
        identity.steamAppId ??= probe.steamAppId;
        identity.prefixId ??= probe.prefixId;
        identity.launcherName ??= probe.launcherName;
    }
}

// Icons usually appear in a burst on enable, one /proc sweep serves them
// all. Pids go stale quickly, so the result never outlives the sweep.
let _nsPidScan = null;

function hostPidsForNsPid(nsPid) {
    _nsPidScan ??= buildNsPidMap().finally(() => (_nsPidScan = null));
    // A failed sweep degrades to "no identity" like every other proc read.
    // Left to propagate, the rejection would take down the whole wrapper.
    return _nsPidScan.then(map => map.get(nsPid) ?? [], () => []);
}

// The last NSpid column is the pid inside the innermost namespace, which
// is what a sandboxed X11 client writes into _NET_WM_PID.
async function buildNsPidMap() {
    const names = await readDirNames(Gio.File.new_for_path('/proc'));
    const pids = names.filter(name => /^\d+$/.test(name));

    const map = new Map();
    await Promise.all(pids.map(async name => {
        const raw = await readProcFile(parseInt(name, 10), 'status', null);
        const fields = raw?.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/);
        if (!fields || fields.length < 2)
            return;
        const inner = parseInt(fields[fields.length - 1], 10);
        const bucket = map.get(inner) ?? [];
        bucket.push(parseInt(name, 10));
        map.set(inner, bucket);
    }));
    return map;
}

async function readEnviron(pid, cancellable) {
    const raw = await readProcFile(pid, 'environ', cancellable);
    if (!raw)
        return new Map();
    const map = new Map();
    for (const entry of raw.split('\0')) {
        const idx = entry.indexOf('=');
        if (idx > 0)
            map.set(entry.slice(0, idx), entry.slice(idx + 1));
    }
    return map;
}

// STEAM_COMPAT_DATA_PATH is set by Proton on every wine/wineserver process.
// Better than SteamGameId (0 for non-Steam shortcuts) or the generic
// "steam_app_<id>" wm_class.
function steamAppIdFromEnviron(env) {
    if (!env.size)
        return null;
    const compatMatch = env.get('STEAM_COMPAT_DATA_PATH')?.match(/\/compatdata\/(\d+)/);
    if (compatMatch && compatMatch[1] !== '0')
        return compatMatch[1];
    for (const key of ['SteamGameId', 'SteamAppId', 'STEAM_APPID']) {
        const v = env.get(key);
        if (v && v !== '0' && /^\d+$/.test(v))
            return v;
    }
    return null;
}

// Wine launchers keep each prefix in its own named directory, so the name
// is still a solid identity when nothing better exists. Numeric names
// are compatdata layouts and belong to steamAppIdFromEnviron.
function prefixIdFromEnviron(env) {
    if (!env.size)
        return null;

    const launcherName = launcherNameFromEnviron(env);
    if (launcherName)
        return sanitizeId(launcherName);

    const gameId = env.get('UMU_ID') || env.get('GAMEID');
    if (gameId && !GENERIC_UMU_GAME_IDS.has(gameId.toLowerCase()))
        return sanitizeId(gameId);

    const root = env.get('STEAM_COMPAT_DATA_PATH') || env.get('WINEPREFIX');
    if (!root)
        return null;

    // Proton prefixes end in /pfx, the parent directory carries the name.
    const parts = root.split('/').filter(Boolean);
    if (parts[parts.length - 1] === 'pfx')
        parts.pop();

    const name = parts[parts.length - 1] ?? '';
    if (!name || name === '.wine' || /^\d+$/.test(name))
        return null;
    return sanitizeId(name);
}

// Not sanitized, the raw value doubles as the display title.
function launcherNameFromEnviron(env) {
    for (const key of WINE_LAUNCHER_ENV_KEYS) {
        const value = env.get(key)?.trim();
        // Purely numeric values are store ids (GOG via Heroic), the
        // prefix directory name makes the better title and id there.
        if (value && !/^\d+$/.test(value))
            return value;
    }
    return null;
}

async function exeBaseFromCmdline(pid, cancellable) {
    const raw = await readProcFile(pid, 'cmdline', cancellable);
    const first = raw?.split('\0')[0];
    return first ? (first.split('/').pop() || '').toLowerCase() : null;
}

async function readPpid(pid, cancellable) {
    const raw = await readProcFile(pid, 'status', cancellable);
    const m = raw?.match(/^PPid:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 0;
}

// Cancellation is re-thrown so callers can short-circuit.
// Any other failure (file missing, decode error) collapses to null.
async function readProcFile(pid, name, cancellable) {
    if (!pid)
        return null;
    try {
        const file = Gio.File.new_for_path(`/proc/${pid}/${name}`);
        const content = await readFileBytes(file, cancellable);
        return new TextDecoder('utf-8', {fatal: false}).decode(content);
    } catch (e) {
        if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return null;
    }
}

const _manifestNameCache = new Map();
async function steamAppNameFromManifest(appId, cancellable) {
    if (!appId)
        return null;
    if (_manifestNameCache.has(appId))
        return _manifestNameCache.get(appId);

    const home = GLib.get_home_dir();
    const candidates = [
        `${home}/.steam/root/steamapps/appmanifest_${appId}.acf`,
        `${home}/.steam/steam/steamapps/appmanifest_${appId}.acf`,
        `${home}/.local/share/Steam/steamapps/appmanifest_${appId}.acf`,
        `${home}/.var/app/com.valvesoftware.Steam/.steam/root/steamapps/appmanifest_${appId}.acf`,
        `${home}/.var/app/com.valvesoftware.Steam/data/Steam/steamapps/appmanifest_${appId}.acf`,
    ];
    /* eslint-disable no-await-in-loop */
    for (const path of candidates) {
        try {
            const file = Gio.File.new_for_path(path);
            const content = await readFileBytes(file, cancellable);
            const text = new TextDecoder('utf-8', {fatal: false}).decode(content);
            const m = text.match(/"name"\s+"([^"]+)"/);
            if (m) {
                _manifestNameCache.set(appId, m[1]);
                return m[1];
            }
        } catch (e) {
            if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            // Manifest missing on this path → try next candidate.
        }
    }
    /* eslint-enable no-await-in-loop */
    _manifestNameCache.set(appId, null);
    return null;
}

function sanitizeId(s) {
    if (!s)
        return '';
    return s.toString().trim().toLowerCase()
        .replace(/\.exe$/, '')
        .replace(/[^a-z0-9._-]/g, '-')
        .replace(/^-+|-+$/g, '');
}

// The TrayManager's bg-color property is a CoglColor on GNOME 49/50.
function parseCssColor(css) {
    if (!css)
        return null;
    const [ok, parsed] = Cogl.color_from_string(css);
    return ok ? parsed : null;
}

let _bgFallbackColor;

function getFallbackBgColor() {
    if (_bgFallbackColor === undefined)
        _bgFallbackColor = parseCssColor(XEMBED_BG_FALLBACK_HEX);
    return _bgFallbackColor;
}
