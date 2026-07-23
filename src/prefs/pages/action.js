import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {createComplexActionRow, createComboRow, createActionRow, createResetButton, GEAR_ICON_NAME} from '../widgets/rows.js';
import {createIconButton} from '../widgets/gtkHelpers.js';
import ConfigDialog from '../dialogs/configDialog.js';
import {TOUCH_BINDING} from '../../const.js';

// Every click, tap and scroll binding shares these prefixes, including the
// gear dialog keys, so a future binding resets without a list edit.
const ACTION_KEY_PREFIXES = Object.freeze(['tray-action-', 'toggle-action-']);

export class ActionPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass({GTypeName: 'BetterTrayIconsActionPage'}, this);
    }

    _init(window, settings) {
        super._init({
            title: _('Actions'),
            icon_name: 'bti-actions-symbolic',
        });

        this._window = window;
        this._settings = settings;
        this._headerActions = null;

        this._clickButtons = [
            {label: _('Left Click'),   suffix: 'left'},
            {label: _('Middle Click'), suffix: 'middle'},
            {label: _('Right Click'),  suffix: 'right'},
        ];

        this.actionOptions = [_('Activate'), _('Open Menu'), _('None')];
        this.actionValues = ['activate', 'menu', 'nothing'];

        this.trayLongOptions = [_('Activate'), _('Open Menu'), _('Reorder (drag & drop)'), _('None')];
        this.trayLongValues = ['activate', 'menu', 'drag-drop', 'nothing'];

        this.toggleOptions = [
            _('Toggle Menu'),
            _('Cycle Icons'),
            _('Action Menu'),
            _('Open Settings'),
            _('None'),
        ];
        this.toggleValues = ['toggle', 'cycle', 'action-menu', 'prefs', 'nothing'];

        this._createTrayClickGroup();
        this._createToggleClickGroup();
    }

    get headerActions() {
        this._headerActions ??= createResetButton(this._settings, this._actionKeys(),
            {window: this._window, includesSubpages: true});
        return this._headerActions;
    }

    _actionKeys() {
        return [
            ...this._settings.list_keys().filter(key =>
                ACTION_KEY_PREFIXES.some(prefix => key.startsWith(prefix))),
            'toggle-hover-menu',
        ];
    }

    _createTrayClickGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Tray Icon Clicks'),
            description: _('Open the gear for double-click and long-press.'),
        });
        this.add(group);

        this._addClickRows(group, {
            keyPrefix: 'tray-action',
            options: this.actionOptions,
            values: this.actionValues,
            longOptions: this.trayLongOptions,
            longValues: this.trayLongValues,
        });
    }

    _createToggleClickGroup() {
        const group = new Adw.PreferencesGroup({title: _('Toggle Button Clicks')});
        this.add(group);

        this._addClickRows(group, {
            keyPrefix: 'toggle-action',
            options: this.toggleOptions,
            values: this.toggleValues,
            longOptions: this.toggleOptions,
            longValues: this.toggleValues,
        });

        group.add(createComboRow(
            _('Scroll'),
            _('Scroll direction picks which way the icons rotate'),
            this._settings,
            'toggle-action-scroll',
            [_('Cycle Icons'), _('None')],
            ['cycle', 'nothing']
        ));

        group.add(createComboRow(
            _('Menu on Hover'),
            _('Which menu opens when you hover the toggle button'),
            this._settings,
            'toggle-hover-menu',
            [_('Overflow Popup'), _('Action Menu')],
            ['overflow', 'action-menu']
        ));
    }

    _addClickRows(group, {keyPrefix, options, values, longOptions, longValues}) {
        this._clickButtons.forEach(({label, suffix}) => {
            const key = `${keyPrefix}-${suffix}`;
            const groups = [{
                title: _('Advanced'),
                configs: [
                    {type: 'combo', title: _('Double Click'), key: `${key}-double`, options,     values},
                    {type: 'combo', title: _('Long Press'),   key: `${key}-long`,   options: longOptions, values: longValues},
                ],
            }];

            group.add(createComplexActionRow(
                label, null, this._settings, key,
                options, values, this._window, ConfigDialog,
                {pageTitle: label, groups}
            ));
        });

        group.add(this._createTouchRow(keyPrefix, {options, values, longOptions, longValues}));
    }

    // Touch has no primary binding a dropdown could show, all three live in
    // the dialog.
    _createTouchRow(keyPrefix, {options, values, longOptions, longValues}) {
        const openDialog = () => new ConfigDialog(this._window, this._settings, {
            pageTitle: _('Touch'),
            groups: [{
                configs: [
                    {type: 'combo', title: _('Tap'),        key: `${keyPrefix}-${TOUCH_BINDING}`, options, values},
                    {type: 'combo', title: _('Double Tap'), key: `${keyPrefix}-${TOUCH_BINDING}-double`, options, values},
                    {type: 'combo', title: _('Long Touch'), key: `${keyPrefix}-${TOUCH_BINDING}-long`, options: longOptions, values: longValues},
                ],
            }],
        }).present(this._window);

        return createActionRow(_('Touch'), _('Tap, double tap and long touch.'), {
            suffixWidgets: [createIconButton(GEAR_ICON_NAME, {
                tooltip_text: _('Configure'),
                callback: openDialog,
            })],
            onActivate: openDialog,
        });
    }
}
