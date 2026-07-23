import {claimAppId, getAppConfigMap, migrateLegacyConfig, releaseAppId} from '../../shared/appConfig.js';
import {joinSplitId} from './appId.js';

const _items = new Map();

// A process that publishes several tray items keys them all under its own
// name, so one item's settings reach its siblings: update-notifier ships two
// and hiding one hid both. Their own Ids tell them apart, but only a process
// proven to own several may fall back on them, because an Id is only as stable
// as the app that sets it and WARP mints a fresh one on every launch.
export function resolveItemId(settings, item) {
    _items.set(item.key, item);

    if (!item.splittable || !item.pid || !item.discriminator) {
        item.appId = item.base;
        return item.base;
    }

    // A split recorded in the config outlives the session, so an item that
    // registers before its sibling still lands on the key it had last time.
    // Only an exact key match takes that shortcut: an unmatched discriminator
    // is a fresh sibling, which the live check below proves, or an id minted
    // new this launch, which would orphan one stored entry per start.
    if (getAppConfigMap(settings)[joinSplitId(item.base, item.discriminator)])
        return _applySplit(settings, item);

    const siblings = [..._items.values()].filter(other =>
        other !== item && other.pid === item.pid && other.base === item.base);
    if (siblings.length === 0) {
        item.appId = item.base;
        return item.base;
    }

    for (const other of siblings) {
        if (other.appId === other.base)
            _applySplit(settings, other);
    }

    return _applySplit(settings, item);
}

export function forgetItem(key) {
    _items.delete(key);
}

// The shell keeps modules loaded across disable/enable, so a dead item would
// otherwise look like a live sibling to the next session's first registration.
export function clearItemSplits() {
    _items.clear();
}

function _applySplit(settings, item) {
    const appId = joinSplitId(item.base, item.discriminator);
    if (appId === item.base)
        return item.base;

    if (item.appId === item.base)
        releaseAppId(item.base);
    claimAppId(appId);
    item.appId = appId;
    // The icon has to hold its new key before the carry-over writes. That write
    // arrives as a settings change, and an icon still on the old key reads the
    // entry's disappearance as a Forget and seeds it straight back.
    item.rekey?.(appId);
    // Whatever the collapsed entry collected is the best guess for both items,
    // nothing recorded which of them the user meant it for.
    migrateLegacyConfig(settings, item.base, appId);
    return appId;
}
