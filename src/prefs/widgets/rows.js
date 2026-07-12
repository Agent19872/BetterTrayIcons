import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {connectScoped} from '../../shared/lifecycle.js';
import {pathOrThemedIcon} from '../../shared/icon.js';
import {ACTION_DROPDOWN_WIDTH_PX} from '../../const.js';
import {createColorButton, createIconButton, attachBadge} from './gtkHelpers.js';
import {openStyleDialog, openUri} from '../dialogs/dialogs.js';

export function buildPrefsWidget(page, settings, keysToReset) {
    const toolbarView = new Adw.ToolbarView();
    page.set_child(toolbarView);

    const headerBar = new Adw.HeaderBar();
    toolbarView.add_top_bar(headerBar);

    if (keysToReset && keysToReset.length > 0) {
        const resetBtn = createIconButton('edit-undo-symbolic', {
            circular: false,
            tooltip_text: _('Reset'),
            callback: () => keysToReset.forEach(key => settings.reset(key)),
        });
        headerBar.pack_end(resetBtn);
    }

    const contentPage = new Adw.PreferencesPage();
    toolbarView.set_content(contentPage);

    return contentPage;
}

// `displayOptions` are the translated user-facing labels, `valueMap` the
// GSettings strings, indexed in parallel.
export function createComboRow(title, subtitle, settings, key, displayOptions, valueMap, options = {}) {
    const dropdown = _createBoundDropdown(settings, key, displayOptions, valueMap, {label: title});
    const row = createActionRow(title, subtitle, {suffixWidgets: [dropdown], activatable: true});

    // Row clicks open the list, the hit target Adw.ComboRow offered.
    row.activatable_widget = dropdown;

    _applyExperimental(row, options, settings, key);

    return row;
}

export function createSpinRow(title, settings, key, min = 0, max = 100, step = 1) {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// `options.variants` adds a paint-bucket button beside the color picker
// that opens a small dialog with related color rows like hover or active.
// Shape: { parent, title, description, items: [{ type:'color', title, key }] }.
export function createColorRow(title, settings, key, options = {}) {
    const row = new Adw.ActionRow({title});
    const colorButton = createColorButton(settings, key, title, {accentKey: options.accentKey});

    // Grey the swatch out while the accent drives this color, it previews the
    // accent but can't be picked until the toggle in the dialog goes back off.
    if (options.accentKey) {
        settings.bind(options.accentKey, colorButton, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);
    }

    // Suffix order matters. Rows pack add_suffix() left-to-right, so the
    // variants paint-bucket goes first to land left of the color swatch.
    if (options.variants && Array.isArray(options.variants.items) && options.variants.items.length > 0) {
        const variants = options.variants;
        const variantBtn = createIconButton('applications-graphics-symbolic', {
            tooltip_text: _('More colors'),
            callback: () => openStyleDialog(options.parent, settings, {
                title: variants.title || title,
                description: variants.description,
                items: variants.items,
            }),
        });
        row.add_suffix(variantBtn);
    }

    row.add_suffix(colorButton);

    return row;
}

export function createSwitchRow(title, subtitle, settings, key, options = {}) {
    const row = new Adw.SwitchRow({
        title,
        subtitle: subtitle || '',
    });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    _applyExperimental(row, options, settings, key);
    return row;
}

export function createSubpageRow(title, subtitle, window, SubpageClass, settings, dependencyKey = null) {
    const row = new Adw.ActionRow({
        title,
        subtitle: subtitle || '',
        activatable: true,
    });

    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER}));

    row.connect('activated', () => {
        const subpage = new SubpageClass(window, settings);
        window.push_subpage(subpage);
    });

    if (dependencyKey)
        settings.bind(dependencyKey, row, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function createIconPickerRow(title, settings, key, window, PickerClass, iconList, options = {}) {
    const row = new Adw.ActionRow({
        title,
        subtitle: settings.get_string(key),
        activatable: true,
    });

    const iconPreview = new Gtk.Image({pixel_size: 24, valign: Gtk.Align.CENTER});

    // ThemedIcon fallback keeps GTK4 from showing a blank image when the
    // icon name isn't in the current theme.
    const applyIconToImage = (img, val) => {
        if (!val) {
            img.clear();
            return;
        }
        img.set_from_gicon(pathOrThemedIcon(val));
    };

    applyIconToImage(iconPreview, settings.get_string(key));

    row.add_suffix(iconPreview);
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER}));

    const updateRow = () => {
        const newVal = settings.get_string(key);
        row.set_subtitle(newVal);
        applyIconToImage(iconPreview, newVal);
    };

    connectScoped(row, settings, `changed::${key}`, updateRow);

    row.connect('activated', () => {
        const picker = new PickerClass(settings, key, iconList, null, null, options);
        picker.present(window);
    });

    return row;
}

export function createComplexActionRow(title, subtitle, settings, mainKey, displayOptions, values, window, AdvancedConfigClass, advancedConfigData, {flat = true} = {}) {
    const row = new Adw.ActionRow({
        title,
        subtitle: subtitle || '',
        activatable: false,
    });

    const gearBtn = createIconButton('emblem-system-symbolic', {
        flat,
        tooltip_text: _('Configure advanced actions'),
        callback: () => {
            const widget = new AdvancedConfigClass(window, settings, advancedConfigData);
            widget.present(window);
        },
    });

    const dropdown = _createBoundDropdown(settings, mainKey, displayOptions, values,
        {flat, width: ACTION_DROPDOWN_WIDTH_PX, label: title});

    row.add_suffix(gearBtn);
    row.add_suffix(dropdown);

    return row;
}

export function bindVisibility(settings, key, widget, targetValue) {
    const updateState = () => {
        const current = settings.get_string(key);
        widget.visible = current === targetValue;
    };

    updateState();
    connectScoped(widget, settings, `changed::${key}`, updateState);
}

export function createActionRow(title, subtitle, options = {}) {
    const {prefixIcon, prefixWidget, suffixIcon, suffixWidgets, headerSuffix, activatable, onActivate, experimental} = options;

    const row = new Adw.ActionRow({
        title,
        subtitle: subtitle || '',
        activatable: activatable || !!onActivate,
    });

    if (onActivate)
        row.connect('activated', onActivate);

    if (prefixIcon)
        row.add_prefix(new Gtk.Image({icon_name: prefixIcon, pixel_size: 24, valign: Gtk.Align.CENTER}));

    if (prefixWidget)
        row.add_prefix(_centered(prefixWidget));

    if (experimental)
        attachBadge(row, _('Experimental'));

    if (headerSuffix) {
        if (headerSuffix instanceof Gtk.Widget)
            headerSuffix.valign = Gtk.Align.CENTER;
        row.add_suffix(headerSuffix);
    }

    for (const widget of suffixWidgets ?? [])
        row.add_suffix(_centered(widget));

    if (suffixIcon)
        row.add_suffix(new Gtk.Image({icon_name: suffixIcon, valign: Gtk.Align.CENTER}));

    return row;
}

export function createLinkRow(title, subtitle, iconName, window, url) {
    return createActionRow(title, subtitle, {prefixIcon: iconName, onActivate: () => openUri(window, url)});
}

export function createExpanderSection({title, subtitle, headerSuffix}) {
    const expander = new Adw.ExpanderRow({
        title,
        subtitle: subtitle || '',
    });

    if (headerSuffix)
        expander.add_suffix(_centered(headerSuffix));

    let rows = [];
    const setRows = next => {
        for (const row of rows)
            expander.remove(row);
        rows = [...next];
        for (const row of rows)
            expander.add_row(row);
    };

    return {expander, setRows};
}

export function createBoxSidesGroup(title, settings, keyPrefix, {min = 0, max = 50, step = 1} = {}) {
    const sides = [
        ['top', _('Top')],
        ['bottom', _('Bottom')],
        ['left', _('Left')],
        ['right', _('Right')],
    ];
    const group = new Adw.PreferencesGroup({title});
    sides.forEach(([side, label]) => {
        group.add(createSpinRow(label, settings, `${keyPrefix}-${side}`, min, max, step));
    });
    return group;
}

// Builds the Icon + Background color row pair used by tray icons and toggle button.
// The paint-bucket dialog holds the accent toggles and the hover color, which
// disappears once its accent toggle takes over.
export function createIconColorPair(parent, settings, keyPrefix) {
    const specs = [
        {title: _('Icon'),       key: `${keyPrefix}color`,            hoverKey: `${keyPrefix}hover-color`,            variantTitle: _('Icon Color')},
        {title: _('Background'), key: `${keyPrefix}background-color`, hoverKey: `${keyPrefix}hover-background-color`, variantTitle: _('Background Color')},
    ];
    return specs.map(s => {
        const accentKey = accentKeyFor(s.key);
        const hoverAccentKey = accentKeyFor(s.hoverKey);
        return createColorRow(s.title, settings, s.key, {
            parent,
            accentKey,
            variants: {
                title: s.variantTitle,
                items: [
                    {type: 'switch', title: _('Use Accent Color'), key: accentKey},
                    {type: 'switch', title: _('Use Accent Color on Hover'), key: hoverAccentKey},
                    {type: 'color', title: _('Hover'), key: s.hoverKey, hiddenByKey: hoverAccentKey},
                ],
            },
        });
    });
}

// Every `<x>-color` key pairs with a `<x>-use-accent-color` boolean.
function accentKeyFor(colorKey) {
    return colorKey.replace(/color$/, 'use-accent-color');
}

// The fixed width only exists where a gear column needs to stay flush,
// the label wires the row title to screen readers like Adw.ComboRow did.
function _createBoundDropdown(settings, key, displayOptions, values, {flat = true, width = -1, label = null} = {}) {
    const dropdown = new Gtk.DropDown({
        model: new Gtk.StringList({strings: displayOptions}),
        valign: Gtk.Align.CENTER,
        width_request: width,
    });

    // The stylesheet has no flat variant for the dropdown node itself,
    // only the internal toggle button picks up button.flat styling.
    if (flat)
        dropdown.get_first_child()?.add_css_class('flat');

    if (label)
        dropdown.update_property([Gtk.AccessibleProperty.LABEL], [label]);

    _bindDropdownSelection(dropdown, settings, key, values);

    return dropdown;
}

// The changed:: side keeps the UI in sync with external writes like
// the Reset button.
function _bindDropdownSelection(widget, settings, key, values) {
    const index = values.indexOf(settings.get_string(key));
    if (index !== -1)
        widget.selected = index;

    widget.connect('notify::selected', () => {
        const selected = widget.selected;
        if (selected >= 0 && selected < values.length)
            settings.set_string(key, values[selected]);
    });

    connectScoped(widget, settings, `changed::${key}`, () => {
        const idx = values.indexOf(settings.get_string(key));
        if (idx !== -1 && widget.selected !== idx)
            widget.selected = idx;
    });
}

// Adw rows stretch prefix and suffix children to the full row height.
function _centered(widget) {
    widget.valign = Gtk.Align.CENTER;
    return widget;
}

// `experimental: true` pins the badge on. `experimentalValues` shows it only
// when the current setting matches one of those values.
function _applyExperimental(row, options, settings, key) {
    if (options.experimental) {
        attachBadge(row, _('Experimental'));
        return;
    }
    const values = options.experimentalValues;
    if (!Array.isArray(values) || values.length === 0)
        return;
    const badge = attachBadge(row, _('Experimental'));
    const update = () => {
        badge.visible = values.includes(settings.get_string(key));
    };
    connectScoped(row, settings, `changed::${key}`, update);
    update();
}
