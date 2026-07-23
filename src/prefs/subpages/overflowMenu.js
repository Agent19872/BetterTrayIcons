import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    createColorRow,
    createSpinRow,
    buildPrefsWidget,
    bindVisibility,
    bindGroupsVisible,
    createSpacingGroup,
    createCustomStyleSwitchGroup,
    createShapeGroup,
} from '../widgets/rows.js';
import {createCardButtonGroup, spacingLinkKey} from '../widgets/gtkHelpers.js';
import {createPreviewGroup, buildLayoutThumbnail, buildOverflowPreview} from '../widgets/preview.js';
import {TRAY_ICON_STYLE_KEYS} from './trayIcons.js';

export const OVERFLOW_STYLE_KEYS = Object.freeze([
    'overflow-layout-mode',
    'grid-column-limit',
    'overflow-container-padding-top',
    'overflow-container-padding-bottom',
    'overflow-container-padding-left',
    'overflow-container-padding-right',
    'overflow-container-margin-top',
    'overflow-container-margin-bottom',
    'overflow-container-margin-left',
    'overflow-container-margin-right',
    'overflow-container-background-color',
    'overflow-container-background-use-accent-color',
    'overflow-container-border-radius',
    'enable-custom-overflow-style',
    spacingLinkKey('overflow-container-padding'),
    spacingLinkKey('overflow-container-margin'),
]);

export default class OverflowMenuSubpage extends Adw.NavigationPage {
    static {
        GObject.registerClass({GTypeName: 'BetterTrayIconsOverflowMenuSubpage'}, this);
    }

    _init(window, settings) {
        super._init({
            title: _('Overflow Container'),
            tag: 'overflow_menu_settings',
        });

        this._window = window;
        this._settings = settings;

        this._buildUI();
    }

    _buildUI() {
        const contentPage = buildPrefsWidget(this, this._settings, OVERFLOW_STYLE_KEYS,
            {window: this._window});

        // The popup renders tray icons, so their styling repaints it too.
        contentPage.add(createPreviewGroup(this._settings, {
            watch: [...OVERFLOW_STYLE_KEYS, ...TRAY_ICON_STYLE_KEYS],
            render: buildOverflowPreview,
        }));

        contentPage.add(createCardButtonGroup({
            title: _('Overflow Layout'),
            settings: this._settings,
            key: 'overflow-layout-mode',
            options: [
                {value: 'row', label: _('Row'), preview: buildLayoutThumbnail('row')},
                {value: 'grid', label: _('Grid'), preview: buildLayoutThumbnail('grid')},
            ],
        }));

        const columnsGroup = new Adw.PreferencesGroup();
        columnsGroup.add(createSpinRow(_('Grid Columns'), this._settings, 'grid-column-limit', 1, 10, 1));
        contentPage.add(columnsGroup);
        bindVisibility(this._settings, 'overflow-layout-mode', columnsGroup, 'grid');

        contentPage.add(createCustomStyleSwitchGroup(this._settings, 'enable-custom-overflow-style'));

        const groupColor = new Adw.PreferencesGroup({title: _('Colors')});
        groupColor.add(createColorRow(_('Background'), this._settings, 'overflow-container-background-color', {
            parent: this._window,
            accentKey: 'overflow-container-background-use-accent-color',
            variants: {
                title: _('Background Color'),
                items: [
                    {type: 'switch', title: _('Use Accent Color'), key: 'overflow-container-background-use-accent-color'},
                ],
            },
        }));
        contentPage.add(groupColor);

        const spacingGroup = createSpacingGroup(this._settings, 'overflow-container');
        contentPage.add(spacingGroup);

        const groupShape = createShapeGroup(this._settings, 'overflow-container-border-radius');
        contentPage.add(groupShape);

        bindGroupsVisible(this, this._settings, [groupColor, spacingGroup, groupShape],
            () => this._settings.get_boolean('enable-custom-overflow-style'), 'enable-custom-overflow-style');
    }
}
