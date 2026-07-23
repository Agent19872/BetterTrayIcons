import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

// SNI has no unread-count property, apps bake the number into their icon
// pixmap. The count itself is broadcast on the Unity LauncherEntry
// interface (Telegram emits it directly, Electron apps via setBadgeCount),
// so one bus-wide subscription is the only way to render it as a badge.
const LAUNCHER_ENTRY_IFACE = 'com.canonical.Unity.LauncherEntry';

const APP_URI_PREFIX = 'application://';

const FLATPAK_APP_ID_PREFIX = 'flatpak-';

// A second digit no longer fits the badge at panel icon sizes.
const UNREAD_BADGE_MAX = 9;

// Launchers and apps disagree on desktop-id casing (our appIds are
// lowercased, the LauncherEntry uri carries the app's own), so every key
// in these maps is stored and compared lowercase.
// desktopId -> {count, visible, sender}
const _entries = new Map();
// sender unique name -> {watchId, ids: Set<desktopId>}
const _senders = new Map();
// desktopId -> Set<callback>
const _listeners = new Map();

let _subscriptionId = 0;

export function enableLauncherEntries() {
    if (_subscriptionId)
        return;
    _subscriptionId = Gio.DBus.session.signal_subscribe(
        null, LAUNCHER_ENTRY_IFACE, 'Update', null, null,
        Gio.DBusSignalFlags.NONE,
        (_conn, sender, _path, _iface, _signal, params) => _onUpdate(sender, params));
}

export function disableLauncherEntries() {
    if (_subscriptionId) {
        Gio.DBus.session.signal_unsubscribe(_subscriptionId);
        _subscriptionId = 0;
    }
    for (const {watchId} of _senders.values())
        Gio.bus_unwatch_name(watchId);
    _senders.clear();
    _entries.clear();
    _listeners.clear();
}

export function unreadBadge(desktopIds) {
    const count = unreadCountFor(desktopIds);
    if (count === null)
        return null;
    return {text: count > UNREAD_BADGE_MAX ? `${UNREAD_BADGE_MAX}+` : String(count)};
}

function unreadCountFor(desktopIds) {
    for (const id of desktopIds ?? []) {
        const entry = _entries.get(id);
        if (entry && entry.visible && entry.count > 0)
            return entry.count;
    }
    return null;
}

// The pid route only resolves windowed apps, and for a flatpak the bus
// hands us the sandbox proxy's pid, which never owns a window. Its appId
// carries the flatpak id though, and that IS the desktop id.
export function desktopIdCandidates({pid = null, appId = null, packagingKind = null} = {}) {
    const out = new Set();
    const tracked = pid
        ? Shell.WindowTracker.get_default().get_app_from_pid(pid)?.get_id() ?? null
        : null;
    if (tracked)
        out.add(tracked.toLowerCase());
    if (packagingKind === 'flatpak' && appId?.startsWith(FLATPAK_APP_ID_PREFIX))
        out.add(`${appId.slice(FLATPAK_APP_ID_PREFIX.length)}.desktop`);
    return [...out];
}

// The pid route above resolves nothing until the app's window is tracked,
// which can land after the icon's last resolve, so a listener that came up
// empty needs this as its wake-up call.
export function addTrackedWindowsListener(callback) {
    const tracker = Shell.WindowTracker.get_default();
    const id = tracker.connect('tracked-windows-changed', callback);
    return () => tracker.disconnect(id);
}

export function addUnreadListener(desktopIds, callback) {
    const ids = (desktopIds ?? []).filter(id => id);
    if (ids.length === 0)
        return null;
    for (const id of ids) {
        let set = _listeners.get(id);
        if (!set)
            _listeners.set(id, set = new Set());
        set.add(callback);
    }
    return () => {
        for (const id of ids) {
            const set = _listeners.get(id);
            set?.delete(callback);
            if (set?.size === 0)
                _listeners.delete(id);
        }
    };
}

function _onUpdate(sender, params) {
    // The subscription matches on name alone, so a peer can serve any
    // signature and its values are its own to choose.
    const unpacked = params.deep_unpack();
    if (!Array.isArray(unpacked))
        return;
    const [appUri, props] = unpacked;
    if (typeof appUri !== 'string' || !appUri.startsWith(APP_URI_PREFIX) ||
        !props || typeof props !== 'object')
        return;
    const desktopId = appUri.slice(APP_URI_PREFIX.length).toLowerCase();

    const entry = _entries.get(desktopId) ?? {count: 0, visible: false};
    const prevCount = entry.count;
    const prevVisible = entry.visible;
    if ('count' in props)
        entry.count = Number(props['count'].deep_unpack());
    if ('count-visible' in props)
        entry.visible = !!props['count-visible'].deep_unpack();
    // Latest emitter owns the entry, so an old instance dying right after a
    // restart cannot wipe what the new one just published.
    entry.sender = sender;
    _entries.set(desktopId, entry);

    _watchSender(sender, desktopId);

    // Electron re-emits Update per progress tick, and every callback here is
    // a full icon resolve.
    if (entry.count === prevCount && entry.visible === prevVisible)
        return;
    for (const callback of _listeners.get(desktopId) ?? [])
        callback();
}

// A killed app never retracts its entry, so the count would stick on the
// badge forever. Watching the emitting connection drops it with the app.
function _watchSender(sender, desktopId) {
    let record = _senders.get(sender);
    if (!record) {
        record = {ids: new Set(), watchId: 0};
        _senders.set(sender, record);
        record.watchId = Gio.bus_watch_name(Gio.BusType.SESSION, sender,
            Gio.BusNameWatcherFlags.NONE, null, () => _dropSender(sender));
    }
    record.ids.add(desktopId);
}

function _dropSender(sender) {
    const record = _senders.get(sender);
    if (!record)
        return;
    Gio.bus_unwatch_name(record.watchId);
    _senders.delete(sender);
    for (const desktopId of record.ids) {
        if (_entries.get(desktopId)?.sender !== sender)
            continue;
        _entries.delete(desktopId);
        for (const callback of _listeners.get(desktopId) ?? [])
            callback();
    }
}
