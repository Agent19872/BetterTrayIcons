import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {setSidebarWindow} from './src/prefs/widgets/sidebar.js';
import {wireSpacingSync} from './src/prefs/widgets/gtkHelpers.js';
import {GeneralPage} from './src/prefs/pages/general.js';
import {AppearancePage} from './src/prefs/pages/appearance.js';
import {ActionPage} from './src/prefs/pages/action.js';
import {ApplicationsPage} from './src/prefs/pages/applications.js';
import {AboutPage} from './src/prefs/pages/about.js';

export default class BetterTrayIconsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this.initTranslations();
        const settings = this.getSettings();

        // Icon themes ship these inconsistently or not at all, proton resolves
        // in none and emblem-synchronizing-symbolic is missing from Adwaita, so
        // the prefs bundle their own and look the same everywhere.
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const bundledIcons = this.dir.get_child('assets').get_child('icons').get_path();
        if (!iconTheme.get_search_path().includes(bundledIcons))
            iconTheme.add_search_path(bundledIcons);

        window.set_default_size(1000, 700);

        wireSpacingSync(window, settings);

        setSidebarWindow(window, [
            new GeneralPage(window, settings),
            new AppearancePage(window, settings),
            new ActionPage(window, settings),
            new ApplicationsPage(window, settings),
            new AboutPage(this.dir, this.metadata, settings),
        ], this.dir.get_child('assets').get_child('icon.png').get_path());
    }
}
