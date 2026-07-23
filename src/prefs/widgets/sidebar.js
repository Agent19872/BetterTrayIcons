import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PREFS_SIDEBAR_BREAKPOINT = 'max-width: 700sp';
const SIDEBAR_HEADER_ICON_PX = 40;


// The shell each window got from setSidebarWindow, so the helpers below can
// route to its navigation view and toast overlay without mutating the window.
const _shells = new WeakMap();

export function setSidebarWindow(window, pages, iconPath) {
    // The prefs service checks visible_page after fillPreferencesWindow and
    // throws "Extension did not provide any UI" when the stock view is empty
    // (extensionPrefsDialog.js), so it gets a stub page it can see.
    window.add(new Adw.PreferencesPage());

    const stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
        vexpand: true,
    });
    pages.forEach(page => stack.add_named(page, page.title));

    const rootPage = new Adw.NavigationPage({title: pages[0].title});
    const contentToolbar = new Adw.ToolbarView();
    const contentHeader = new Adw.HeaderBar();
    contentToolbar.add_top_bar(contentHeader);
    contentToolbar.set_content(stack);
    rootPage.set_child(contentToolbar);

    const navView = new Adw.NavigationView();
    navView.add(rootPage);

    const list = new Gtk.ListBox({
        css_classes: ['navigation-sidebar'],
        selection_mode: Gtk.SelectionMode.BROWSE,
    });
    pages.forEach(page => list.append(_createSidebarRow(page)));

    // No header bar: its fixed min-height and own inset fought the brand
    // box's margins, leaving the icon out of step with the row icons below
    // it. A plain box lets the brand's own margins be the only ones in play.
    const sidebarBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    sidebarBox.append(new Gtk.ScrolledWindow({
        child: list,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vexpand: true,
    }));

    const sidebarToolbar = new Adw.ToolbarView();
    sidebarToolbar.set_content(sidebarBox);

    const splitView = new Adw.OverlaySplitView({
        sidebar: sidebarToolbar,
        content: navView,
    });
    sidebarBox.prepend(_createSidebarHeader(window.get_title(), iconPath, splitView));

    list.connect('row-selected', (_list, row) => {
        if (!row)
            return;
        const page = pages[row.get_index()];
        // Mapping the overlay re-emits the current selection. Without this
        // guard the echo closed the sidebar in the same dispatch it opened
        // in (measured: show-sidebar flipped true->false instantly).
        if (stack.get_visible_child() === page)
            return;
        // A subpage left open while switching sections would keep covering
        // the freshly selected page.
        navView.pop_to_page(rootPage);
        stack.set_visible_child(page);
        rootPage.set_title(page.title);
    });
    // Activation instead of selection, so only a real click or Enter
    // closes the overlay, never the mapping echo above.
    list.connect('row-activated', () => {
        navView.pop_to_page(rootPage);
        if (splitView.collapsed)
            splitView.show_sidebar = false;
    });
    list.select_row(list.get_row_at_index(0));

    // Collapsing auto-hides the sidebar and un-collapsing brings it back
    // whatever the toggle did in between, no extra setter needed
    // (AdwOverlaySplitView:pin-sidebar docs).
    const breakpoint = new Adw.Breakpoint({
        condition: Adw.BreakpointCondition.parse(PREFS_SIDEBAR_BREAKPOINT),
    });
    breakpoint.add_setter(splitView, 'collapsed', true);
    window.add_breakpoint(breakpoint);

    contentHeader.pack_start(_createSidebarToggle(splitView));

    // Some pages need controls that only make sense while they're the one
    // showing (e.g. Applications' bulk actions), so a page contributes its
    // own optional widget instead of every page sharing one fixed header.
    pages.forEach(page => {
        if (page.headerActions)
            contentHeader.pack_end(page.headerActions);
    });
    const syncHeaderActions = () => {
        const active = stack.get_visible_child();
        pages.forEach(page => {
            if (page.headerActions)
                page.headerActions.visible = page === active;
        });
    };
    stack.connect('notify::visible-child', syncHeaderActions);
    syncHeaderActions();

    const overlay = new Adw.ToastOverlay({child: splitView});
    window.set_content(overlay);

    _shells.set(window, {navView, overlay, splitView});
}

export function pushSubpage(window, page) {
    _shells.get(window).navView.push(page);
}

export function popSubpage(window) {
    _shells.get(window).navView.pop();
}

export function addToast(window, toast) {
    _shells.get(window).overlay.add_toast(toast);
}

// Subpages build their own header bars and cover the root one, so each
// fetches its own toggle instead of sharing the root header's.
export function createSidebarToggle(window) {
    return _createSidebarToggle(_shells.get(window).splitView);
}

function _createSidebarToggle(splitView) {
    const btn = new Gtk.ToggleButton({css_classes: ['flat']});
    splitView.bind_property('show-sidebar', btn, 'active',
        GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE);
    // Expanded, the sidebar is a fixed pane and the button has no job.
    splitView.bind_property('collapsed', btn, 'visible', GObject.BindingFlags.SYNC_CREATE);

    const sync = () => {
        btn.icon_name = btn.active ? 'bti-sidebar-hide-symbolic' : 'bti-sidebar-show-symbolic';
        btn.tooltip_text = btn.active ? _('Hide Sidebar') : _('Show Sidebar');
    };
    btn.connect('notify::active', sync);
    sync();

    return btn;
}

function _createSidebarHeader(title, iconPath, splitView) {
    const box = new Gtk.Box({
        spacing: 12,
        margin_top: 18,
        margin_bottom: 14,
        margin_start: 12,
        margin_end: 12,
    });
    try {
        // Scaled at load and shown in a picture: a Gtk.Image would shrink
        // the texture back to icon size, and a picture fed the raw file
        // would request its full size and inflate the header bar.
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
            iconPath, SIDEBAR_HEADER_ICON_PX, SIDEBAR_HEADER_ICON_PX, true);
        box.append(new Gtk.Picture({paintable: Gdk.Texture.new_for_pixbuf(pixbuf)}));
    } catch { /* the text still names the sidebar */ }
    const labels = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER});
    labels.append(new Gtk.Label({label: title, halign: Gtk.Align.START, css_classes: ['heading']}));
    labels.append(new Gtk.Label({label: _('Settings'), halign: Gtk.Align.START, css_classes: ['caption', 'dim-label']}));
    box.append(labels);

    // In the collapsed overlay the sidebar covers the header toggle, so it
    // carries its own way to close.
    const collapse = _createSidebarToggle(splitView);
    collapse.hexpand = true;
    collapse.halign = Gtk.Align.END;
    collapse.valign = Gtk.Align.CENTER;
    box.append(collapse);

    return box;
}

function _createSidebarRow(page) {
    const box = new Gtk.Box({
        spacing: 12,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 6,
        margin_end: 6,
    });
    box.append(new Gtk.Image({icon_name: page.icon_name}));
    box.append(new Gtk.Label({label: page.title}));
    return new Gtk.ListBoxRow({child: box});
}
