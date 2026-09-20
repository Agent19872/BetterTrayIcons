import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {TRAY_STYLE_KEYS} from '../../const.js';
import {updateAppConfig} from '../../shared/appConfig.js';
import {disconnectAll, disconnectSignal, disposeAll, ruleDispatcher} from '../../shared/lifecycle.js';
import {warn} from '../../shared/logging.js';
import {connectSurfaceChanges} from '../actorPlacement.js';
import {isDisposed, watchDisposal} from '../disposal.js';
import {connectColorSetChanges, refreshTrayStyle, syncHoverStyle} from '../trayStyle.js';
import {
    DRAG_SETTING_KEYS,
    findIcon,
    forwardDragStateToIndicator,
    setupIconDragSource,
    syncDragEnabled,
} from '../features/dragAndDrop.js';

// Without this our boxes would take a foreign child down with them.
export const FOREIGN_ACTOR_PROP = '_isForeign';

export class ForeignItems {
    constructor({getIndicator, getSettings}) {
        this._getIndicator = getIndicator;
        this._getSettings = getSettings;
        this._items = new Map();
    }

    add({id, actor, title = null, onReleased = null}) {
        if (typeof id !== 'string' || !id)
            throw new Error('a foreign item needs an id');
        if (!(actor instanceof Clutter.Actor) || isDisposed(actor))
            throw new Error(`foreign item ${id} brought no usable actor`);
        if (this._items.has(id))
            throw new Error(`foreign item ${id} is already in the tray`);

        // One watch per actor, an owner may stand the same one under two ids.
        const watch = this._watchFor(actor) ??
            {handlerId: watchDisposal(actor, () => this._dropActor(actor))};

        this._items.set(id, {
            id,
            actor,
            title,
            onReleased,
            watch,
            placed: false,
            ownStyle: null,
            draggable: null,
            colorWatch: null,
            settingsIds: [],
            actorIds: [],
        });
        this.place();
    }

    // The api answers a mainloop turn before the indicator and the settings
    // exist (extension.js), so an item handed in that early waits here instead
    // of being refused.
    place() {
        const settings = this._getSettings();
        const indicator = this._getIndicator();
        if (!settings || !indicator)
            return;

        for (const item of this._items.values()) {
            if (item.placed)
                continue;
            item.placed = true;
            // The strip hides and orders from an app-configs entry, so a foreign
            // item needs one, and only its owner can give it a name a user
            // recognises.
            item.actor._appId = item.id;
            item.actor[FOREIGN_ACTOR_PROP] = true;
            updateAppConfig(settings, item.id, {title: item.title, is_foreign: true});
            this._bindItem(item, settings, indicator);
            indicator.addIcon(item.id, item.actor);
        }
    }

    // Styling and the drag source both go through St, a plain Clutter actor
    // keeps the look its owner gave it.
    _bindItem(item, settings, indicator) {
        if (!(item.actor instanceof St.Widget))
            return;

        item.ownStyle = item.actor.get_style();
        const restyle = () => refreshTrayStyle(item.actor, findIcon(item.actor), settings);
        restyle();

        item.draggable = setupIconDragSource({
            actor: item.actor,
            appId: item.id,
            settings,
            onForwardedDragStateChange: forwardDragStateToIndicator(indicator),
        });

        item.actorIds.push(
            item.actor.connect('notify::hover', () => syncHoverStyle(item.actor)),
            connectSurfaceChanges(item.actor, restyle)
        );

        const rules = [
            {match: key => TRAY_STYLE_KEYS.includes(key), run: restyle},
            {
                match: key => DRAG_SETTING_KEYS.includes(key),
                run: () => syncDragEnabled(item.draggable, settings),
            },
        ];
        item.settingsIds.push(settings.connect('changed', ruleDispatcher(rules)));
        item.colorWatch = connectColorSetChanges(settings, restyle);
    }

    remove(id) {
        const item = this._items.get(id);
        if (!item)
            return;

        this._items.delete(id);
        this._detach(item);
        this._getIndicator()?.removeIcon(id);
    }

    releaseAll() {
        const going = [...this._items.values()];
        this._items.clear();
        const indicator = this._getIndicator();

        for (const item of going) {
            this._detach(item);
            indicator?.removeIcon(item.id);
        }
        // Every actor is loose before the first owner hears about it. An owner
        // that reparents inside its callback would otherwise have the next round
        // of the loop above take its actor straight back out.
        for (const item of going) {
            try {
                item.onReleased?.();
            } catch (e) {
                warn(`The owner of ${item.id} threw while taking it back: ${e.message}`);
            }
        }
    }

    // An owner may drop its actor without handing the item back, and the stale
    // row would turn the next offer under that id into a throw.
    _dropActor(actor) {
        for (const [id, item] of this._items) {
            if (item.actor !== actor)
                continue;
            this._items.delete(id);
            this._detach(item);
            this._getIndicator()?.removeIcon(id);
        }
    }

    _detach(item) {
        disconnectAll(item, this._getSettings(), 'settingsIds');
        disposeAll(item, 'disconnect', 'colorWatch');
        disposeAll(item, 'destroy', 'draggable');
        if (isDisposed(item.actor))
            return;

        disconnectAll(item, item.actor, 'actorIds');
        // Another row can stand on the same actor and still needs the watch.
        if (!this._watchFor(item.actor))
            disconnectSignal(item.watch, item.actor, 'handlerId');
        if (item.actor instanceof St.Widget)
            item.actor.set_style(item.ownStyle);
        item.actor.get_parent()?.remove_child(item.actor);
    }

    _watchFor(actor) {
        for (const item of this._items.values()) {
            if (item.actor === actor)
                return item.watch;
        }
        return null;
    }
}
