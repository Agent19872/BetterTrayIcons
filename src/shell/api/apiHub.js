import {API_MARKER, API_VERSION} from '../../shared/api/ids.js';
import {ForeignItems} from './foreignItems.js';

// The schema goes out as id and directory, a live Gio.Settings would let a
// peer write our keys.
export class ApiHub {
    constructor(extension, getIndicator, getSettings) {
        this.marker = API_MARKER;
        this.version = API_VERSION;
        this._extension = extension;
        this._getIndicator = getIndicator;
        this._foreign = new ForeignItems({getIndicator, getSettings});
    }

    // `onReleased` is called when this extension goes down, so the caller can
    // take its item back rather than lose it with our boxes.
    addForeignItem(item) {
        if (!this._foreign)
            throw new Error('the tray is on its way out');
        this._foreign.add(item);
    }

    removeForeignItem(id) {
        this._foreign?.remove(id);
    }

    placeForeignItems() {
        this._foreign?.place();
    }

    // Null until the deferred setup has built the indicator.
    get trayContainer() {
        return this._getIndicator?.() ?? null;
    }

    get schemaId() {
        return this._extension?.metadata['settings-schema'] ?? null;
    }

    get schemaDir() {
        return this._extension?.dir.get_child('schemas').get_path() ?? null;
    }

    destroy() {
        // Before the release below. A peer asked to take its items back looks
        // this api up again, and a hub on its way out must not answer.
        this.marker = null;
        this._foreign?.releaseAll();
        this._foreign = null;
        this._extension = null;
        this._getIndicator = null;
    }
}
