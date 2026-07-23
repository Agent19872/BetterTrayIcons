import GLib from 'gi://GLib';

// AppImage runtime basenames. These are the generic wrapper, not the app,
// so every AppImage would collide on one id. The real name comes from the
// APPIMAGE env var (the .AppImage path), stable and unique per file.
export const APPIMAGE_WRAPPERS = new Set(['apprun.wrapped', 'apprun']);

export const APP_ID_EXE_SUFFIX_RE = /\.exe$/i;

// Unicode-aware so a non-Latin identity keeps its characters instead of
// sanitizing down to nothing.
const APP_ID_INVALID_RE = /[^\p{L}\p{N}._-]+/gu;

const APP_ID_PID_SUFFIX_RE = /[-_](\d+)$/;

const APP_ID_HASH_LENGTH = 8;

// Joins the process key to the item's own Id when one process publishes
// several items. APP_ID_INVALID_RE collapses '@' to a dash, so a plain id can
// never grow one on its own and a split key stays recognizable as such.
const APP_ID_SPLIT_SEPARATOR = '@';

// Joins the packaging kind to the container's own name for the app. A dot would
// read as a reverse-DNS id and formatAppName would show only the last segment,
// so all three builds would be listed under one name.
const PACKAGING_ID_SEPARATOR = '-';

// Battery and network icon names encode live state, so they can't
// identify an app. A Solaar restart on another charge level would
// otherwise mint a fresh id.
const STATEFUL_ICON_NAME_RE = /^(battery|network)[-_]/i;


// One sanitizer for the SNI and the XEmbed path. They name the same concept,
// and two spellings of it would key one app under two entries.
export function sanitizeAppId(raw) {
    if (typeof raw !== 'string')
        return null;

    const trimmed = raw.trim();
    if (!trimmed)
        return null;

    const cleaned = trimmed.toLowerCase()
        .replace(APP_ID_EXE_SUFFIX_RE, '')
        .replace(APP_ID_INVALID_RE, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');

    // An identity written purely in symbols used to sanitize down to an empty
    // string, which left the app unconfigurable and invisible in the prefs.
    return cleaned || `u-${_shortHash(trimmed)}`;
}

// The process is the identity of record, because the SNI Id is only as good as
// the app that sets it, and measured against real apps it often isn't: WARP
// randomises it per launch, OpenRGB reports its AppImage wrapper, Wooting ships
// a placeholder. The Id leads only where no process can be resolved, e.g. a
// flatpak whose bus connection belongs to the sandbox proxy.
// Null means nothing identified the item, which keeps it session-volatile
// rather than minting a bus-name key that changes on every restart.
export function pickAppId({processName, rawId, pid, iconThemePath, iconName, title, packaging}) {
    // A contained build is its own app as far as config goes, and the container
    // names it better than anything the item reports: the native, snap and
    // flatpak KeePassXC all call themselves 'KeePassXC'.
    if (packaging)
        return sanitizeAppId(`${packaging.kind}${PACKAGING_ID_SEPARATOR}${packaging.id}`);

    const process = sanitizeAppId(processName);
    if (process)
        return process;

    const id = sanitizeAppId(_stripPidSuffix(rawId, pid));
    if (id && !isGenericId(id))
        return id;

    if (iconThemePath) {
        const match = iconThemePath.match(/([a-z0-9-_]+\.[a-z0-9-_]+\.[a-z0-9-_]+)/i);
        if (match && !match[1].includes('freedesktop'))
            return sanitizeAppId(match[1]);
    }

    if (iconName && iconName.length > 2 && !isGenericIconName(iconName)) {
        const stripped = sanitizeAppId(iconName.replace(/[-_](symbolic|tray|panel)$/i, ''));
        if (stripped && !isGenericId(stripped))
            return stripped;
    }

    // A title carrying a counter changes on its own, and each spelling would
    // leave another dead entry behind.
    if (title && !/\d/.test(title) && (!title.includes(' ') || title.length < 20)) {
        const fromTitle = sanitizeAppId(title);
        if (fromTitle && !isGenericId(fromTitle))
            return fromTitle;
    }

    return null;
}

export function joinSplitId(base, discriminator) {
    const suffix = sanitizeAppId(discriminator);
    return suffix ? `${base}${APP_ID_SPLIT_SEPARATOR}${suffix}` : base;
}

// A faithful replay of the scheme this release replaces, so an existing entry
// can be carried over instead of silently starting from defaults.
//
// It duplicates the rules above. Sharing them is exactly how this broke:
// every tweak to the live scheme silently moved the key the migration went
// looking for, and the lookup missed an entry sitting right there. This
// describes a released artifact, so it is frozen. Do not "improve" it.
export function legacyAppId({legacyName, rawId, iconThemePath, iconName, title, busName}) {
    let candidate = null;
    if (legacyName) {
        candidate = legacyName;
    } else if (rawId && !_legacyIsGenericId(rawId)) {
        candidate = rawId;
    } else if (iconThemePath) {
        const match = iconThemePath.match(/([a-z0-9-_]+\.[a-z0-9-_]+\.[a-z0-9-_]+)/i);
        if (match && !match[1].includes('freedesktop'))
            candidate = match[1];
    }
    if (!candidate && iconName && iconName.length > 2 && !_legacyIsGenericIconName(iconName)) {
        const stripped = iconName.replace(/[-_](symbolic|tray|panel)$/i, '');
        if (!_legacyIsGenericId(stripped))
            candidate = stripped;
    }
    if (!candidate && title && (!title.includes(' ') || title.length < 20))
        candidate = title;

    const raw = candidate ?? rawId ?? busName?.replace(/[:.]/g, '_');
    return raw
        ? raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-._]/g, '')
        : null;
}

// An AppImage's SNI Title is often the wrapper name (AppRun.wrapped), so the
// name derived from the APPIMAGE path is the real one.
export function pickDisplayTitle({title, processName, appId, busName}) {
    const titleIsWrapper = title && APPIMAGE_WRAPPERS.has(title.split('/').pop().toLowerCase());
    return (titleIsWrapper ? processName : title) ?? appId ?? busName;
}

export function isGenericId(id) {
    if (!id)
        return true;
    const lower = id.toLowerCase();
    return APPIMAGE_WRAPPERS.has(lower) ||
        lower.includes('chrome_status_icon') ||
        lower.includes('status_icon') ||
        lower.includes('indicator') ||
        lower.startsWith('state-') ||
        lower.startsWith('libappindicator') ||
        lower.startsWith('task-') ||
        lower === 'app';
}

export function isGenericIconName(name) {
    if (!name)
        return true;
    const lower = name.toLowerCase();
    return lower.startsWith('state-') ||
        lower.startsWith('sync-') ||
        lower === 'image-missing' ||
        lower.includes('panel') ||
        STATEFUL_ICON_NAME_RE.test(lower);
}

// Apps that append their own pid to the Id (Dropbox) would otherwise look
// like a different app on every launch. KDE special-cases that one name,
// comparing against the sender's pid covers every app that does it.
function _stripPidSuffix(rawId, pid) {
    if (!rawId || !pid)
        return rawId;
    const match = rawId.match(APP_ID_PID_SUFFIX_RE);
    return match && match[1] === String(pid) ? rawId.slice(0, match.index) : rawId;
}

function _shortHash(value) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, value, -1)
        .slice(0, APP_ID_HASH_LENGTH);
}

// Frozen alongside legacyAppId: the live isGenericId/isGenericIconName have
// since gained rules the released scheme never had.
function _legacyIsGenericId(id) {
    if (!id)
        return true;
    const lower = id.toLowerCase();
    return lower.includes('chrome_status_icon') ||
        lower.includes('status_icon') ||
        lower.includes('indicator') ||
        lower.startsWith('state-') ||
        lower.startsWith('libappindicator') ||
        lower.startsWith('task-') ||
        lower === 'app';
}

function _legacyIsGenericIconName(name) {
    if (!name)
        return true;
    const lower = name.toLowerCase();
    return lower.startsWith('state-') ||
        lower.startsWith('sync-') ||
        lower === 'image-missing' ||
        lower.includes('panel');
}
