import {safeBounds} from '../utils/actor.js';

// GNOME's dnd.js hands drop targets actor._delegate as source, which
// dragAndDrop.js points at the DraggableTrayIcon wrapper. The fallbacks
// catch delegates that only carry the _draggableItem back-link.
export function getDraggableFromSource(source) {
    if (!source)
        return null;
    if (typeof source.appId === 'string')
        return source;
    if (source._draggableItem)
        return source._draggableItem;
    if (source.actor?._draggableItem)
        return source.actor._draggableItem;
    return null;
}

export function isPointInActor(x, y, actor) {
    const b = actor && safeBounds(actor);
    if (!b)
        return false;
    const [ax, ay, aw, ah] = b;
    return x >= ax && x <= ax + aw && y >= ay && y <= ay + ah;
}

export function nearestRowIndex(items, x) {
    for (const [i, [cx, , cw]] of _eachBounds(items)) {
        if (x < cx + cw / 2)
            return i;
    }
    return items.length;
}

export function nearestGridIndex(items, x, y) {
    for (const [i, [cx, cy, cw, ch]] of _eachBounds(items)) {
        if (x >= cx && x <= cx + cw && y >= cy && y <= cy + ch)
            return x > cx + cw / 2 ? i + 1 : i;
    }

    let nearest = -1;
    let bestDist = Infinity;
    let nearestX = 0, nearestW = 0;
    for (const [i, [cx, cy, cw, ch]] of _eachBounds(items)) {
        const dx = x - (cx + cw / 2);
        const dy = y - (cy + ch / 2);
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
            bestDist = d;
            nearest = i;
            nearestX = cx;
            nearestW = cw;
        }
    }

    if (nearest === -1)
        return items.length;
    return x > nearestX + nearestW / 2 ? nearest + 1 : nearest;
}

export function dragStageCoords(dragActor) {
    const b = safeBounds(dragActor);
    if (!b)
        return global.get_pointer();
    const [x, y, w, h] = b;
    return [x + w / 2, y + h / 2];
}

function* _eachBounds(items) {
    for (let i = 0; i < items.length; i++) {
        const b = safeBounds(items[i].actor);
        if (b)
            yield [i, b];
    }
}
