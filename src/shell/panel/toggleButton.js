import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {disposeAll} from '../../shared/lifecycle.js';
import {isDisposed, trackDisposal, computeToggleStyle, createPanelMenu, applyPanelClasses} from '../utils/actor.js';
import {ClickController} from '../features/clickController.js';

export class ToggleButton {
    constructor(settings, {openPreferences, cycleIcons}) {
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._cycleIcons = cycleIcons;
        this._overflowMenu = null;
        this._actionMenu = null;
        this._actionMenuOverflowItem = null;

        this._icon = new St.Icon({
            icon_name: this._settings.get_string('toggle-icon-name'),
            style_class: 'system-status-icon',
        });

        this.actor = new St.Button({
            child: this._icon,
            style_class: 'panel-button better-tray-toggle-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.connect('notify::hover', () => this.updateState());
        this.actor.connect('scroll-event', (_actor, event) => this._onScroll(event));
        trackDisposal(this.actor);

        // Unlike tray items, which pass events through so middle-click and DnD
        // keep working, the toggle stops clicks from reaching the panel.
        this._clickController = new ClickController(
            this.actor,
            this._settings,
            'toggle',
            action => this._executeAction(action),
            {propagateEvent: false}
        );
    }

    // The overflow menu anchors its popup to `.actor`, so it can only be built
    // after this constructor ran.
    setOverflowMenu(overflowMenu) {
        this._overflowMenu = overflowMenu;
    }

    updateStyle() {
        if (!this._icon || !this.actor || !this._settings)
            return;

        // An imported blob can hold an empty string, the schema default is
        // the one place that knows the real fallback.
        const iconName = this._settings.get_string('toggle-icon-name') ||
            this._settings.get_default_value('toggle-icon-name').unpack();
        if (this._icon.icon_name !== iconName)
            this._icon.icon_name = iconName;

        const customToggle = this._settings.get_boolean('enable-custom-toggle-style');
        applyPanelClasses(this.actor, this._icon, customToggle);

        const style = computeToggleStyle(this._settings);
        this._baseStyle = style.baseStyle;
        this._hoverStyle = style.hoverStyle;
        this._iconColor = style.iconColor;
        this._iconHoverColor = style.iconHoverColor;

        this._icon.set_icon_size(this._settings.get_int('toggle-icon-size'));
        this._icon.set_style(this._iconColor ? `color: ${this._iconColor};` : '');
        this.actor.set_style(this._baseStyle);

        this.updateState();
    }

    updateState() {
        const isMenuOpen = this._overflowMenu?.isOpen;
        const isHover = this.actor.hover;
        const isActive = isMenuOpen || isHover;

        if (this._baseStyle) {
            if (isActive) {
                this.actor.set_style(`${this._baseStyle} ${this._hoverStyle}`);
                if (this._icon && this._iconHoverColor)
                    this._icon.set_style(`color: ${this._iconHoverColor};`);
            } else {
                this.actor.set_style(this._baseStyle);
                if (this._icon && this._iconColor)
                    this._icon.set_style(`color: ${this._iconColor};`);
            }
        } else if (isMenuOpen) {
            this.actor.add_style_pseudo_class('active');
        } else {
            this.actor.remove_style_pseudo_class('active');
        }
    }

    applyHoverMenuOrder() {
        const manager = Main.panel.menuManager;
        if (!manager || !this._overflowMenu?.isAttached)
            return;

        // The hover switch only picks between menus already in the manager,
        // so the lazily built action menu has to exist before its first open.
        this._ensureActionMenu();

        // removeMenu on an open menu drops its modal grab.
        if (this._actionMenu.isOpen || this._overflowMenu.isOpen)
            return;

        // Both menus share the toggle as source actor, and the manager opens
        // the first match it finds, so their order picks the hover menu.
        const actionFirst = this._settings.get_string('toggle-hover-menu') === 'action-menu';

        manager.removeMenu(this._actionMenu);
        this._overflowMenu.detachFromManager();

        if (actionFirst) {
            manager.addMenu(this._actionMenu);
            this._overflowMenu.attachToManager();
        } else {
            this._overflowMenu.attachToManager();
            manager.addMenu(this._actionMenu);
        }
    }

    // Discrete directions only: SMOOTH carries the fractional deltas that
    // proportional widgets like the volume slider consume, and rotating the
    // order per delta would spin it.
    _onScroll(event) {
        if (this._settings.get_string('toggle-action-scroll') !== 'cycle')
            return Clutter.EVENT_PROPAGATE;

        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            this._cycleIcons(true);
            break;
        case Clutter.ScrollDirection.DOWN:
            this._cycleIcons(false);
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    _executeAction(action) {
        const handlers = {
            'toggle': () => this._overflowMenu.toggle(),
            'cycle': () => this._cycleIcons(),
            'action-menu': () => this._openActionMenu(),
            'prefs': () => this._openPreferences(),
        };
        handlers[action]?.();
    }

    _openActionMenu() {
        this._ensureActionMenu();
        if (this._actionMenuOverflowItem)
            this._actionMenuOverflowItem.setSensitive(!!this.actor?.visible);

        this._actionMenu.toggle();
    }

    _ensureActionMenu() {
        if (this._actionMenu)
            return;

        this._actionMenu = createPanelMenu(this.actor);

        if (Main.panel.menuManager)
            Main.panel.menuManager.addMenu(this._actionMenu);

        this._actionMenuOverflowItem = new PopupMenu.PopupMenuItem(_('Open Overflow Menu'));
        this._actionMenuOverflowItem.connect('activate', () => {
            this._actionMenu.close();
            if (this.actor?.visible)
                this._overflowMenu.open();
        });
        this._actionMenu.addMenuItem(this._actionMenuOverflowItem);

        const prefsItem = new PopupMenu.PopupMenuItem(_('Open Settings'));
        prefsItem.connect('activate', () => {
            this._actionMenu.close();
            this._openPreferences();
        });
        this._actionMenu.addMenuItem(prefsItem);
    }

    destroy() {
        // The action menu has to leave Main.panel.menuManager before it's
        // destroyed.
        if (this._actionMenu) {
            try {
                Main.panel.menuManager?.removeMenu(this._actionMenu);
            } catch { /* not in manager */ }
        }

        disposeAll(this, 'destroy', '_clickController', '_actionMenu');
        this._actionMenuOverflowItem = null;

        if (this.actor && !isDisposed(this.actor))
            this.actor.destroy();
        this.actor = null;
        this._icon = null;
        this._overflowMenu = null;
    }
}
