import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {warnOnce} from './logging.js';
import {fileExists, readFileBytes, probePaths} from './fetch.js';

// symbolic is the freedesktop convention, panel the Ubuntu/ayatana one.
const MONO_ICON_SUFFIXES = Object.freeze(['-symbolic', '-panel']);

// Bare "mono" marks monochrome assets without being a theme variant
// suffix, so it isn't in the list above.
const MONO_ICON_NAME_RE = new RegExp(
    `[-_](${MONO_ICON_SUFFIXES.map(s => s.slice(1)).join('|')}|mono)$`, 'i');

// Fallback-asset names like steam_tray_mono, from apps without theme
// integration. Stripping them reveals the base name a theme can cover,
// while -symbolic and -panel names are deliberate choices and stay as is.
export const MONO_ASSET_SUFFIX_RE = /([-_]tray)?[-_]mono$/i;

const ICON_CACHE_SUBDIR = 'bettertrayicons/icons';

const ICON_FILE_EXTENSIONS = Object.freeze(['.png', '.svg', '.xpm', '.ico']);

// Deep enough for <path>/hicolor/22x22/apps/foo.png, shallow enough that an
// app pointing IconThemePath at a large tree can't stall a resolve.
const ICON_THEME_TREE_MAX_DEPTH = 4;

// A snap carries its revision ahead of the theme tree
// (/snap/x/123/hicolor/48x48/apps/y.png), so the size is the last size-shaped
// segment, not the first. The lookahead leaves the trailing slash behind so
// /123/16x16/ still yields both. Scaled dirs (16x16@2x, 128x128@2) must match
// too, or the last match falls back onto the revision.
const ICON_THEME_SIZE_RE = /\/(\d+)(?:x\d+)?(?:@\d+x?)?(?=\/)/g;

// Feed the result to resolveIcon and applyResolvedIcon so neither stats while
// a widget is being built. Theme lookups ride in the same map under
// themeProbeKey, false in there means probed and missed.
export async function probeIconPaths(configs, cancellable = null) {
    const paths = new Set();
    const themed = new Map();
    for (const config of configs) {
        for (const p of [config?.custom_icon, config?.cached_icon_path]) {
            if (typeof p === 'string' && p.startsWith('/'))
                paths.add(p);
        }
        const key = themeProbeKey(config);
        if (key && !themed.has(key))
            themed.set(key, config);
    }

    const map = await probePaths(paths, cancellable);
    await Promise.all([...themed].map(async ([key, config]) => {
        const hit = await findIconInThemeAsync(
            config.detected_icon, config.icon_theme_path, cancellable);
        map.set(key, hit ?? false);
    }));
    return map;
}

// Null when resolveIcon could never reach the theme walk for this config.
export function themeProbeKey(config) {
    const name = config?.detected_icon;
    if (config?.custom_icon || !name || name.startsWith('/') || !config?.icon_theme_path)
        return null;
    return `${config.icon_theme_path}\0${name}`;
}

// Only the prefs side has an icon theme at hand to answer `hasThemeIcon`.
export function resolveIcon(config, hasThemeIcon = null, cachedPathExists = null, themeHit = null) {
    if (!config)
        return {type: 'name', value: 'image-missing'};

    if (config.custom_icon) {
        if (config.custom_icon.startsWith('/'))
            return {type: 'file', value: config.custom_icon};

        return {type: 'name', value: config.custom_icon};
    }

    const iconName = config.detected_icon;

    // A resolvable name beats any cached copy: the theme recolors it for
    // light and dark and renders it at the exact size, a snapshot does
    // neither. Also repairs entries an older version polluted with a copy
    // of the theme file.
    if (iconName && !iconName.startsWith('/') && hasThemeIcon?.(iconName))
        return {type: 'name', value: iconName};

    // Without this check, a stale cached path would show as image-missing
    // instead of falling back to the themed name below.
    if (config.cached_icon_path) {
        const exists = cachedPathExists ??
            Gio.File.new_for_path(config.cached_icon_path).query_exists(null);
        if (exists)
            return {type: 'file', value: config.cached_icon_path};
    }

    if (iconName) {
        if (iconName.startsWith('/'))
            return {type: 'file', value: iconName};

        if (config.icon_theme_path) {
            // null keeps the blocking walk, which only a caller off the
            // render path can afford, same contract as cachedPathExists.
            const resolvedPath = themeHit === null
                ? findIconInTheme(iconName, config.icon_theme_path)
                : themeHit;
            if (resolvedPath)
                return {type: 'file', value: resolvedPath};
        }

        return {type: 'name', value: iconName};
    }

    return {type: 'name', value: 'image-missing'};
}

export function findIconInTheme(iconName, themePath, targetSize = 0) {
    if (!iconName || !themePath)
        return null;

    const {wanted, paths} = _candidatePaths(iconName, themePath);
    for (const fullPath of paths) {
        if (Gio.File.new_for_path(fullPath).query_exists(null))
            return fullPath;
    }

    return _findIconInThemeTree(Gio.File.new_for_path(themePath), wanted, targetSize);
}

// The probe-phase twin of findIconInTheme. The walk is forked because the
// sync and async enumerator APIs share no shape, the scoring stays shared.
export async function findIconInThemeAsync(iconName, themePath, cancellable = null) {
    if (!iconName || !themePath)
        return null;

    const {wanted, paths} = _candidatePaths(iconName, themePath);
    const found = await Promise.all(paths.map(p => fileExists(p, cancellable)));
    const first = found.indexOf(true);
    if (first !== -1)
        return paths[first];

    return _findIconInThemeTreeAsync(Gio.File.new_for_path(themePath), wanted, cancellable);
}

// A bare name can also be a file with its extension already attached, so
// both spellings are probed, flat first and then the theme tree.
function _candidatePaths(iconName, themePath) {
    const candidates = [iconName, ...ICON_FILE_EXTENSIONS.map(ext => `${iconName}${ext}`)];
    const cleanPath = themePath.endsWith('/') ? themePath : `${themePath}/`;
    return {wanted: new Set(candidates), paths: candidates.map(cand => `${cleanPath}${cand}`)};
}

async function _findIconInThemeTreeAsync(dir, wanted, cancellable) {
    let best = null;
    let bestScore = Infinity;

    const walk = async (current, depth) => {
        if (depth > ICON_THEME_TREE_MAX_DEPTH)
            return;
        let children;
        try {
            children = await current.enumerate_children_async('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        } catch {
            return;
        }
        for await (const info of children) {
            const child = children.get_child(info);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                await walk(child, depth + 1);
                continue;
            }
            if (!wanted.has(info.get_name()))
                continue;
            const score = _sizeDistance(child.get_path(), 0);
            if (best === null || score < bestScore) {
                bestScore = score;
                best = child.get_path();
            }
        }
    };
    await walk(dir, 0);

    return best;
}

// KDE apps point IconThemePath at a directory laid out like a real icon theme
// (<path>/hicolor/22x22/apps/foo.png) rather than the flat folder probed
// above, and both <size>/<context> and <context>/<size> orderings ship in the
// wild, so match on the file name and read the size off the path afterwards.
function _findIconInThemeTree(dir, wanted, targetSize) {
    let best = null;
    let bestScore = Infinity;

    const walk = (current, depth) => {
        if (depth > ICON_THEME_TREE_MAX_DEPTH)
            return;
        let children;
        try {
            children = current.enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            return;
        }
        for (let info = children.next_file(null); info; info = children.next_file(null)) {
            const child = children.get_child(info);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                walk(child, depth + 1);
                continue;
            }
            if (!wanted.has(info.get_name()))
                continue;
            const score = _sizeDistance(child.get_path(), targetSize);
            // A tree whose paths carry no size segment scores every file
            // Infinity, and Infinity < Infinity kept none of them, so a
            // matching file sitting right there resolved to nothing.
            if (best === null || score < bestScore) {
                bestScore = score;
                best = child.get_path();
            }
        }
        children.close(null);
    };
    walk(dir, 0);

    return best;
}

// Scalable art fits every slot, so it wins unless a raster variant matches
// the requested size exactly.
function _sizeDistance(path, targetSize) {
    if (path.endsWith('.svg'))
        return 0.5;
    if (!targetSize)
        return 1;
    const sizes = [...path.matchAll(ICON_THEME_SIZE_RE)];
    return sizes.length ? Math.abs(Number(sizes.at(-1)[1]) - targetSize) : Infinity;
}

// For the prefs side only. GTK falls back to image-missing on its own, and
// spelling it out here would bury a name it could still resolve (see
// orderThemedNames). St needs the opposite, which orderThemedNames handles.
export function themedIcon(name) {
    return new Gio.ThemedIcon({name: name || 'image-missing'});
}

// Leaving exists null keeps the blocking stat, same contract as resolveIcon.
export function pathOrThemedIcon(value, exists = null) {
    if (!value)
        return themedIcon('image-missing');
    if (value.startsWith('/')) {
        const file = Gio.File.new_for_path(value);
        const found = exists ?? file.query_exists(null);
        return found ? new Gio.FileIcon({file}) : themedIcon('image-missing');
    }
    return themedIcon(value);
}

// GTK and St disagree on how they resolve a multi-name themed icon, so the one
// order that is right for both is: the name we already know resolves, first.
// GTK is theme-major (gtkicontheme.c real_choose_icon, themes outer), a name
// the active theme carries beats one only reachable further down the chain, so
// a trailing image-missing buries e.g. a flatpak icon living in hicolor.
// St is name-major (st-icon-theme.c real_choose_icon, names outer), the first
// name wins wherever it lives, but St paints nothing when none resolve, so
// image-missing still has to be there once nothing else can render.
// `themeKnown` false means nobody could answer, so leave the choice to the
// render-time lookup rather than pinning a fallback it might not need.
export function orderThemedNames(candidates, existing, themeKnown = true) {
    if (existing)
        return [existing, ...candidates.filter(n => n !== existing)];
    return themeKnown ? [...candidates, 'image-missing'] : candidates;
}

export function buildSymbolicCandidates(name, useSymbolic) {
    if (!name)
        return [];

    const base = name.replace(MONO_ASSET_SUFFIX_RE, '');
    if (base && base !== name) {
        const variants = MONO_ICON_SUFFIXES.map(suffix => `${base}${suffix}`);
        return useSymbolic ? [...variants, name, base] : [base, name];
    }

    if (MONO_ICON_NAME_RE.test(name))
        return [name];

    const variants = MONO_ICON_SUFFIXES.map(suffix => `${name}${suffix}`);
    return useSymbolic ? [...variants, name] : [name, ...variants];
}

let _cacheDirPath = null;

export async function writeCachedIcon(appId, pngBytes) {
    const path = pngBytes?.length ? _cachedIconPath(appId) : null;
    if (!path)
        return null;
    const file = Gio.File.new_for_path(path);

    try {
        if (file.query_exists(null)) {
            const existing = await readFileBytes(file);
            if (existing.length === pngBytes.length && _bytesEqual(existing, pngBytes))
                return path;
        }

        // Async so a frame's cache write never blocks the compositor.
        await file.replace_contents_async(
            GLib.Bytes.new(pngBytes),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
        return path;
    } catch (e) {
        warnOnce(`icon-cache-write:${appId}`, `iconCache: write failed for ${appId}: ${e.message}`);
        return null;
    }
}

// The file can vanish between the exists check and the delete.
export function deleteCachedIcon(appId) {
    const path = _cachedIconPath(appId);
    if (!path)
        return;
    const file = Gio.File.new_for_path(path);
    try {
        if (file.query_exists(null))
            file.delete(null);
    } catch { /* gone */ }
}

function _cachedIconPath(appId) {
    // An app-config key reaches here as the file name, and an imported sync
    // file or a hand-edited dconf value never passed through sanitizeAppId.
    // GLib.build_filenamev keeps a '..' hop, Gio.File then resolves it.
    if (!appId || appId.includes('/'))
        return null;
    const dir = _ensureCacheDir();
    return GLib.build_filenamev([dir, `${appId}.png`]);
}

function _ensureCacheDir() {
    if (_cacheDirPath)
        return _cacheDirPath;
    _cacheDirPath = GLib.build_filenamev([GLib.get_user_cache_dir(), ICON_CACHE_SUBDIR]);
    const dir = Gio.File.new_for_path(_cacheDirPath);
    if (!dir.query_exists(null)) {
        try {
            dir.make_directory_with_parents(null);
        } catch (e) {
            warnOnce('icon-cache-dir', `iconCache: could not create ${_cacheDirPath}: ${e.message}`);
        }
    }
    return _cacheDirPath;
}

function _bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }

    return true;
}
