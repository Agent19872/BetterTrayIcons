import GLib from 'gi://GLib';

export const removeTimer = id => GLib.source_remove(id);

export function disposeAll(target, method, ...props) {
    for (const prop of props) {
        if (target[prop]) {
            target[prop][method]();
            target[prop] = null;
        }
    }
}

// For timeout or signal ids.
export function clearIds(target, remover, ...props) {
    for (const prop of props) {
        if (target[prop]) {
            remover(target[prop]);
            target[prop] = 0;
        }
    }
}

// `method` defaults to 'disconnect'. Gio.DBusProxy uses 'disconnectSignal'.
export function disconnectSignal(target, source, prop, method = 'disconnect') {
    if (target[prop]) {
        try {
            source[method](target[prop]);
        } catch { /* source already disposed */ }
        target[prop] = 0;
    }
}

// Per-id try/catch so a half-disposed source still releases the rest.
export function disconnectAll(target, source, prop, method = 'disconnect') {
    const ids = target[prop];
    if (!Array.isArray(ids))
        return;
    for (const id of ids) {
        try {
            source[method](id);
        } catch { /* source disposed mid-loop */ }
    }
    target[prop] = [];
}

// GTK4 fires no `destroy` on a mere unparent, so a plain connect on a
// long-lived source would keep the widget alive for the whole process.
// A dialog emits only `closed`, hence the event.
export function connectScoped(target, source, signal, callback, event = null) {
    const id = source.connect_object(signal, callback, target, 0);
    if (event) {
        target.connect(event, () => {
            try {
                source.disconnect(id);
            } catch { /* already gone with the target */ }
        });
    }
    return id;
}
