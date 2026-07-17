import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {warn, error} from './logging.js';
import {safeMapFromParsed} from './appConfig.js';
import {readFileBytes, readFileText, probePaths} from './fetch.js';
import {COLOR_PATTERN} from '../const.js';

// Await this before importSettingsFromJSON, which has to stay synchronous so
// the shell's _importing flag spans exactly its own writes.
export function probeImportIconPaths(data, cancellable = null) {
    const homeDir = GLib.get_home_dir();
    const paths = new Set();

    const collect = icon => {
        if (typeof icon !== 'string')
            return;
        const resolved = _expandHome(icon, homeDir);
        if (resolved.startsWith('/'))
            paths.add(resolved);
    };

    const configs = data?.['app-configs'];
    if (configs && typeof configs === 'object') {
        for (const conf of Object.values(configs)) {
            if (!conf || typeof conf !== 'object')
                continue;
            const states = conf.state_icons;
            if (states && typeof states === 'object' && !Array.isArray(states))
                Object.values(states).forEach(collect);
            collect(conf.custom_icon);
        }
    }

    return probePaths(paths, cancellable);
}

export function importSettingsFromJSON(settings, data, iconPaths = new Map()) {
    if (!data || typeof data !== 'object')
        return;

    // A scratch instance in delay mode turns the import into one dconf
    // transaction instead of a write plus signal fan-out per key.
    const batch = new Gio.Settings({settings_schema: settings.settings_schema});
    batch.delay();

    const keys = batch.list_keys();
    const homeDir = GLib.get_home_dir();

    Object.keys(data).forEach(key => {
        if (!keys.includes(key))
            return;

        let val = data[key];

        if (_isMalformedColor(key, val)) {
            warn(`Import: Skipping malformed color for '${key}': ${val}`);
            return;
        }

        if (typeof val === 'string')
            val = _expandHome(val, homeDir);

        // app-configs is stored as a JSON string in GSettings, so re-encode it.
        if (key === 'app-configs' && typeof val === 'object') {
            val = JSON.stringify(safeMapFromParsed(val, (appId, conf) =>
                _sanitizeAppConfigForImport(appId, conf, homeDir, iconPaths)
            ));
        }

        const typeString = batch.get_value(key).get_type_string();
        try {
            batch.set_value(key, GLib.Variant.new(typeString, val));
        } catch (e) {
            warn(`Failed to import key '${key}': ${e.message}`);
        }
    });

    batch.apply();
}

export async function saveSettingsToFile(settings, path) {
    await _rotateFile(path, settings.get_int('max-backups'));
    const data = _exportSettingsToJSON(settings);
    const jsonString = JSON.stringify(data, null, 2);

    // The sync file often lives on a network mount, so every write here
    // is async to keep the calling main loop responsive.
    const file = Gio.File.new_for_path(path);
    await file.replace_contents_async(
        GLib.Bytes.new(new TextEncoder().encode(jsonString)),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}

export async function loadSettingsFromFile(settings, path) {
    const file = Gio.File.new_for_path(path);
    let jsonString;

    if (path.endsWith('.gz')) {
        const fileStream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
        const decompressor = Gio.ZlibDecompressor.new(Gio.ZlibCompressorFormat.GZIP);
        const converterStream = Gio.ConverterInputStream.new(fileStream, decompressor);
        const outStream = Gio.MemoryOutputStream.new_resizable();
        await outStream.splice_async(
            converterStream,
            Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
            GLib.PRIORITY_DEFAULT,
            null
        );
        jsonString = new TextDecoder().decode(outStream.steal_as_bytes().get_data());
    } else {
        jsonString = await readFileText(file);
    }

    const data = JSON.parse(jsonString);
    importSettingsFromJSON(settings, data, await probeImportIconPaths(data));
}

// Old versions wrote the backups uncompressed, hence the optional `.gz`.
// One directory enumeration instead of stat-probing every candidate slot,
// which hurts on network mounts.
export async function listBackups(path) {
    const file = Gio.File.new_for_path(path);
    const parent = file.get_parent();
    if (!parent)
        return [];

    const base = file.get_basename();
    const backups = [];
    try {
        const enumerator = await parent.enumerate_children_async(
            'standard::name,time::modified',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null
        );

        for await (const info of enumerator) {
            const name = info.get_name();
            if (!name.startsWith(`${base}.`))
                continue;
            const match = name.slice(base.length).match(/^\.(\d+)(\.gz)?$/);
            if (!match)
                continue;
            backups.push({
                index: parseInt(match[1], 10),
                path: parent.get_child(name).get_path(),
                compressed: !!match[2],
                mtime: info.get_modification_date_time(),
            });
        }
    } catch {
        return [];
    }

    backups.sort((a, b) => a.index - b.index);
    return backups;
}

export async function deleteBackups(path) {
    if (!path)
        return;
    const backups = await listBackups(path);
    await Promise.all([_deleteAsync(path), ...backups.map(b => _deleteAsync(b.path))]);
}

export function deleteBackup(path, index) {
    if (!path || !index)
        return Promise.resolve();
    return _deleteAsync(`${path}.${index}.gz`);
}

function _exportSettingsToJSON(settings) {
    const keys = settings.list_keys();
    const exportData = {};
    const homeDir = GLib.get_home_dir();

    // Used on import to skip changes this host wrote itself.
    exportData['_meta'] = {
        source: GLib.get_host_name(),
        timestamp: Date.now(),
    };

    keys.forEach(key => {
        const val = settings.get_value(key);
        let nativeVal = val.deep_unpack();

        if (key === 'app-configs' && typeof nativeVal === 'string') {
            try {
                nativeVal = JSON.parse(nativeVal);

                Object.keys(nativeVal).forEach(appId => {
                    const conf = nativeVal[appId];
                    if (conf.custom_icon && typeof conf.custom_icon === 'string' && conf.custom_icon.startsWith(homeDir))
                        conf.custom_icon = conf.custom_icon.replace(homeDir, '$HOME');
                    for (const [state, icon] of Object.entries(conf.state_icons ?? {})) {
                        if (typeof icon === 'string' && icon.startsWith(homeDir))
                            conf.state_icons[state] = icon.replace(homeDir, '$HOME');
                    }
                });
            } catch { /* keep raw string */ }
        }

        if (typeof nativeVal === 'string' && nativeVal.startsWith(homeDir))
            nativeVal = nativeVal.replace(homeDir, '$HOME');

        exportData[key] = nativeVal;
    });

    return exportData;
}

async function _rotateFile(path, maxBackups) {
    const backups = (await listBackups(path)).filter(b => b.compressed);

    // Drop slots above the new ceiling so a lowered max-backups doesn't
    // leave orphaned files behind.
    const stale = backups.filter(b => b.index > maxBackups);
    await Promise.all(stale.map(b => _deleteAsync(b.path)));

    // Shift N to N+1, highest first so no move lands on an occupied slot
    // that still has to move itself.
    const toShift = backups
        .filter(b => b.index <= maxBackups - 1)
        .sort((a, b) => b.index - a.index);
    /* eslint-disable no-await-in-loop */
    for (const b of toShift)
        await _moveAsync(b.path, `${path}.${b.index + 1}.gz`);
    /* eslint-enable no-await-in-loop */

    const mainFile = Gio.File.new_for_path(path);
    try {
        const content = await readFileBytes(mainFile);
        await _writeCompressed(`${path}.1.gz`, content);
    } catch (e) {
        // A missing main file just means there's nothing to back up yet.
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            error(`Backup compression failed: ${e.message}`, e);
    }
}

async function _writeCompressed(path, content) {
    const file = Gio.File.new_for_path(path);
    const fileStream = await file.replace_async(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, GLib.PRIORITY_DEFAULT, null);

    const compressor = Gio.ZlibCompressor.new(Gio.ZlibCompressorFormat.GZIP, -1);
    const converterStream = Gio.ConverterOutputStream.new(fileStream, compressor);

    await converterStream.write_all_async(content, GLib.PRIORITY_DEFAULT, null);
    await converterStream.close_async(GLib.PRIORITY_DEFAULT, null);
}

function _moveAsync(sourcePath, destPath) {
    return new Promise(resolve => {
        const source = Gio.File.new_for_path(sourcePath);
        const dest = Gio.File.new_for_path(destPath);
        source.move_async(dest, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null, (obj, res) => {
            try {
                obj.move_finish(res);
            } catch (e) {
                warn(`Backup rotation failed for ${sourcePath} -> ${destPath}: ${e.message}`);
            }
            resolve();
        });
    });
}

function _isMalformedColor(key, val) {
    return key.includes('color') && typeof val === 'string' && !COLOR_PATTERN.test(val);
}

// Null drops the whole entry, so an icon path that doesn't exist on
// this machine never survives a cross-device import.

function _expandHome(value, homeDir) {
    return value.includes('$HOME') ? value.split('$HOME').join(homeDir) : value;
}

// An unprobed path is left alone rather than dropped.
function _isMissingIcon(path, iconPaths) {
    return path.startsWith('/') && iconPaths.get(path) === false;
}

function _sanitizeAppConfigForImport(appId, appConf, homeDir, iconPaths) {
    if (!appConf || typeof appConf !== 'object' || Array.isArray(appConf))
        return null;

    // A string here would have Object.entries walk its characters and the
    // loop below assign to a read-only index.
    if (appConf.state_icons && (typeof appConf.state_icons !== 'object' || Array.isArray(appConf.state_icons)))
        delete appConf.state_icons;

    for (const [state, icon] of Object.entries(appConf.state_icons ?? {})) {
        if (typeof icon !== 'string')
            continue;
        const resolved = _expandHome(icon, homeDir);
        appConf.state_icons[state] = resolved;
        if (_isMissingIcon(resolved, iconPaths)) {
            warn(`Import: Dropping state ${state} of ${appId}, icon not found: ${resolved}`);
            delete appConf.state_icons[state];
        }
    }

    if (!appConf.custom_icon || typeof appConf.custom_icon !== 'string')
        return appConf;

    appConf.custom_icon = _expandHome(appConf.custom_icon, homeDir);

    if (_isMissingIcon(appConf.custom_icon, iconPaths)) {
        warn(`Import: Skipping ${appId}, custom icon not found: ${appConf.custom_icon}`);
        return null;
    }

    return appConf;
}

function _deleteAsync(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null, (obj, res) => {
            try {
                obj.delete_finish(res);
            } catch { /* gone or never existed */ }
            resolve();
        });
    });
}
