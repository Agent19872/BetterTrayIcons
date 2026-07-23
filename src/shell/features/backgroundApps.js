import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {disconnectAll, clearIds, removeTimer} from '../../shared/lifecycle.js';

// Measured on 5 real GDM logins (2026-07-20, Ubuntu 25.10 / GNOME 49): the
// Background Apps quick-settings item was found within 255-260ms every
// time, one idle-loop iteration after the poll started. This deadline
// keeps an order of magnitude of headroom over that, so the wait ends
// quickly if a future shell drops the item for good instead of polling
// forever.
const BACKGROUND_TOGGLE_WAIT_MS = 3000;

// GNOME lists windowless apps in its own Quick Settings entry, which is a
// second place to look next to the tray this extension already provides.
//
// Hiding it needs more than setting visible: the shell's own _syncVisibility
// puts it back whenever the background portal reports a change or the session
// mode updates (status/backgroundApps.js in the shell's gresource). Replacing
// that method on the instance is what makes it stay away, and the original goes
// back on disable so the entry returns exactly as the shell left it.
export class BackgroundApps {
    constructor(settings) {
        this._settings = settings;
        this._settingsSignals = [];
        this._toggle = null;
        this._originalSync = null;
        this._findToggleId = 0;
    }

    enable() {
        this._settingsSignals.push(this._settings.connect(
            'changed::hide-background-apps', () => this._sync()));
        this._sync();
    }

    disable() {
        disconnectAll(this, this._settings, '_settingsSignals');
        clearIds(this, removeTimer, '_findToggleId');
        this._restore();
    }

    _sync() {
        // The shell can rebuild quick settings. The override then sits on a
        // dead instance while the new row shows again, so re-resolve first.
        if (this._originalSync && this._toggle !== this._findToggle())
            this._restore();

        if (this._settings.get_boolean('hide-background-apps'))
            this._hide();
        else
            this._restore();
    }

    _hide() {
        if (this._originalSync)
            return;

        const toggle = this._findToggle();
        if (!toggle) {
            // Quick Settings populates optional items (Bluetooth, networking,
            // this one) through dynamic imports after extensions are already
            // enabled, so the item can be missing on the very first _sync().
            // Confirmed by a GNOME developer for the same _system item:
            // https://discourse.gnome.org/t/main-panel-statusarea-quicksettings-system-is-undefined/16827
            this._awaitToggle();
            return;
        }
        this._applyOverride(toggle);
    }

    _awaitToggle() {
        if (this._findToggleId)
            return;
        const deadline = GLib.get_monotonic_time() + BACKGROUND_TOGGLE_WAIT_MS * 1000;
        this._findToggleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const toggle = this._findToggle();
            if (toggle) {
                this._findToggleId = 0;
                this._applyOverride(toggle);
                return GLib.SOURCE_REMOVE;
            }
            if (GLib.get_monotonic_time() > deadline) {
                this._findToggleId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _applyOverride(toggle) {
        this._toggle = toggle;
        this._originalSync = toggle._syncVisibility;
        // The shell defines this on the class, so putting it back as an own
        // property would shadow whatever a later shell version puts on the
        // prototype. Only a toggle that already carried its own gets one back.
        this._hadOwnSync = Object.hasOwn(toggle, '_syncVisibility');
        toggle._syncVisibility = () => {
            toggle.visible = false;
        };
        toggle.visible = false;
    }

    _restore() {
        clearIds(this, removeTimer, '_findToggleId');

        if (!this._originalSync)
            return;

        const toggle = this._toggle;
        const original = this._originalSync;
        this._toggle = null;
        this._originalSync = null;

        // A rebuilt quick settings dropped this instance. Restoring
        // visibility on it would throw into the settings signal.
        try {
            if (this._hadOwnSync)
                toggle._syncVisibility = original;
            else
                delete toggle._syncVisibility;
            toggle._syncVisibility();
        } catch { /* gone with the old quick settings */ }
    }

    // Reaching into the shell's own indicator, so every step is optional:
    // a future release can rename or drop this and the toggle then does
    // nothing rather than taking the extension down with it.
    _findToggle() {
        return Main.panel?.statusArea?.quickSettings?._backgroundApps
            ?.quickSettingsItems?.[0] ?? null;
    }
}
