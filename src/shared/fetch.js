import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {warn} from './logging.js';

// The one _promisify block for the whole extension. It patches shared
// prototypes, so every module in both processes gets them by importing
// from here, which they all do already.
const promisify = (proto, ...methods) => methods.forEach(m => Gio._promisify(proto, m));

promisify(Gio.File.prototype, 'load_contents_async', 'enumerate_children_async', 'query_info_async');
promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'close_async');

export async function fetchJson(url, cancellable = null) {
    const bytes = await fetchBytes(url, cancellable);
    return JSON.parse(new TextDecoder().decode(bytes.get_data()));
}

export async function fetchBytes(url, cancellable = null) {
    try {
        const contents = await readFileBytes(Gio.File.new_for_uri(url), cancellable);
        return new GLib.Bytes(contents);
    } catch (e) {
        if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            warn(`fetch: ${url} failed: ${e.message}`);
        throw e;
    }
}

// GJS strips the boolean ok value from promisified throwing calls, the
// resolved tuple is [contents, etag] and failures reject instead.
// One round trip per path on a network mount, so probe them all at once.
export async function probePaths(paths, cancellable = null) {
    const probed = await Promise.all(
        [...paths].map(async path => [path, await fileExists(path, cancellable)])
    );
    return new Map(probed);
}

// A user-chosen path can sit on a network mount, where query_exists blocks
// the calling main loop for a round trip.
export async function fileExists(path, cancellable = null) {
    try {
        await Gio.File.new_for_path(path).query_info_async(
            'standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );
        return true;
    } catch (e) {
        if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return false;
    }
}

export async function readFileBytes(file, cancellable = null) {
    const [contents] = await file.load_contents_async(cancellable);
    return contents;
}

export async function readFileText(file, cancellable = null) {
    return new TextDecoder('utf-8', {fatal: false}).decode(await readFileBytes(file, cancellable));
}

// next_files_async returns at most the requested count, so drain in batches.
export async function readDirNames(file, cancellable = null) {
    const enumerator = await file.enumerate_children_async(
        'standard::name',
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        cancellable
    );

    const names = [];
    const batchSize = 250;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const infos = await enumerator.next_files_async(batchSize, GLib.PRIORITY_DEFAULT, cancellable);
        if (infos.length === 0)
            break;
        for (const info of infos)
            names.push(info.get_name());
    }
    enumerator.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    return names;
}

