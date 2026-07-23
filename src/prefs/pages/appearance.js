import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import ToggleButtonSubpage, {TOGGLE_STYLE_KEYS} from '../subpages/toggleButton.js';
import OverflowMenuSubpage, {OVERFLOW_STYLE_KEYS} from '../subpages/overflowMenu.js';
import TrayIconsSubpage, {TRAY_ICON_STYLE_KEYS} from '../subpages/trayIcons.js';

import {createSubpageRow, createResetButton} from '../widgets/rows.js';

const APPEARANCE_RESET_KEYS = Object.freeze([
    ...TRAY_ICON_STYLE_KEYS,
    ...TOGGLE_STYLE_KEYS,
    ...OVERFLOW_STYLE_KEYS,
]);

export class AppearancePage extends Adw.PreferencesPage {
    static {
        GObject.registerClass({GTypeName: 'BetterTrayIconsAppearancePage'}, this);
    }

    _init(window, settings) {
        super._init({
            title: _('Appearance'),
            icon_name: 'bti-color-symbolic',
        });

        this._window = window;
        this._settings = settings;
        this._headerActions = null;

        const group = new Adw.PreferencesGroup({title: _('Elements')});
        this.add(group);

        const surfaces = [
            [_('Tray Icons'), _('Size, padding, colors'), TrayIconsSubpage, 'view-grid-symbolic'],
            [_('Toggle Button'), _('Icon, position, colors'), ToggleButtonSubpage, 'pan-down-symbolic'],
            [_('Overflow Menu'), _('Background, radius, spacing'), OverflowMenuSubpage, 'open-menu-symbolic'],
        ];
        surfaces.forEach(([title, subtitle, subpageClass, prefixIcon]) => {
            group.add(createSubpageRow(title, subtitle, this._window, subpageClass, this._settings, {prefixIcon}));
        });
    }

    get headerActions() {
        this._headerActions ??= createResetButton(this._settings, APPEARANCE_RESET_KEYS,
            {window: this._window, includesSubpages: true});
        return this._headerActions;
    }
}
