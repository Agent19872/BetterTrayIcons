// GJS logs a critical on every member access of a disposed GObject and its
// string carries no disposed marker, so probing is both noisy and blind.
const _destroyedActors = new WeakSet();

export function watchDisposal(actor, onDestroy = null) {
    return actor.connect('destroy', () => {
        _destroyedActors.add(actor);
        onDestroy?.();
    });
}

export function trackDisposal(actor) {
    watchDisposal(actor);
    return actor;
}

export function isDisposed(actor) {
    return !actor || _destroyedActors.has(actor);
}
