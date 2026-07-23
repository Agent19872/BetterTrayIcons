import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {safeBounds} from '../utils/actor.js';

// Lives in Main.layoutManager.uiGroup so it can move during a drag without
// mutating any container's child list. Mutating actor children while DND
// iterates crashed the shell with a g_hash_table_iter_next assertion.
export class DragPlaceholder {
    constructor() {
        this._actor = null;
    }

    _ensureActor() {
        if (this._actor)
            return this._actor;
        this._actor = new St.Widget({
            width: 3,
            height: 24,
            reactive: false,
            style: 'background-color: rgba(255,255,255,0.9); border-radius: 2px;',
            visible: false,
        });
        Main.layoutManager.uiGroup.add_child(this._actor);
        return this._actor;
    }

    showAt(items, targetIndex) {
        if (items.length === 0) {
            this.hide();
            return;
        }

        const placeholder = this._ensureActor();

        const atEnd = targetIndex >= items.length;
        const target = (atEnd ? items[items.length - 1] : items[targetIndex]).actor;
        const b = safeBounds(target);
        if (!b) {
            this.hide();
            return;
        }
        const [cx, cy, cw, ch] = b;
        const px = atEnd ? cx + cw - 1 : cx - 2;
        const py = cy;
        const height = ch;

        placeholder.set_position(Math.round(px), Math.round(py));
        placeholder.set_size(3, Math.round(height));
        placeholder.visible = true;

        // Each menu.open raises the popup actor inside uiGroup, so on
        // subsequent drags the placeholder would render behind the popup.
        const parent = placeholder.get_parent();
        if (parent) {
            try {
                parent.set_child_above_sibling(placeholder, null);
            } catch { /* parent gone mid-drag */ }
        }
    }

    hide() {
        if (this._actor)
            this._actor.visible = false;
    }

    destroy() {
        if (this._actor) {
            this.hide();
            this._actor.destroy();
            this._actor = null;
        }
    }
}
