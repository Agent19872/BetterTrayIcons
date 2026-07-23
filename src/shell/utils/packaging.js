import {readProcFile} from '../../shared/fetch.js';

// These tokens change between AppImage releases and would make the
// derived id unstable.
const APPIMAGE_NOISE_TOKEN_RE =
    /^(x86|x64|amd64|arm64|aarch64|i[0-9]86|linux|win32|win64|mac|beta|alpha|rc\d+|nightly|latest)$/i;

// Interpreter and runtime binaries name the runtime, not the app, so two
// Python tray apps would collide on one id.
export const GENERIC_PROCESS_NAME_RE =
    /^(python[\d.]*|node(js)?|electron[\d.]*|gjs|java|mono|ruby|perl|php|lua[\d.]*|(ba|z|da)?sh)$/i;

// systemd names a snap's scope after the snap and a flatpak's after the app id.
// Measured against a KeePassXC that denies /proc/<pid>/exe, environ and root:
// the cgroup still reads, which is why it leads over the environment here.
const SNAP_CGROUP_RE = /\/snap\.([^./]+)\./;

const FLATPAK_CGROUP_RE = /\/app-flatpak-(.+)-\d+\.scope/;

const FLATPAK_INFO_NAME_RE = /^name=(.+)$/m;

// systemd escapes anything outside [A-Za-z0-9:_.] in a unit name, so an app id
// carrying a dash arrives as \x2d.
const SYSTEMD_UNIT_ESCAPE_RE = /\\x([0-9a-f]{2})/gi;

const APPIMAGE_PATH_RE = /\.appimage$/i;

// AppRun execs the payload out of the runtime's own mountpoint, so the process
// that registers the tray item reports a path in there instead of the .AppImage.
const APPIMAGE_MOUNT_PATH_RE = /\/\.mount_[^/]+\//;

// Which build of an app this is. The same program installed natively and as a
// flatpak runs side by side and reports the same Id, so one config entry served
// both: hiding one hid the other, and both their state icons piled into a
// single app as if they were states of it.
//
// Native returns null, so the key an existing install already has stays
// exactly where it is and only the contained builds move.
export async function resolvePackaging({pid, binaryPath = null, appImageName = null}) {
    if (appImageName)
        return {kind: 'appimage', id: appImageName};

    const cgroup = pid ? await readProcFile(pid, 'cgroup') : null;

    const snap = cgroup?.match(SNAP_CGROUP_RE);
    if (snap)
        return {kind: 'snap', id: snap[1]};

    const flatpak = cgroup?.match(FLATPAK_CGROUP_RE);
    if (flatpak)
        return {kind: 'flatpak', id: _unescapeUnitName(flatpak[1])};

    // An AppImage runs in the plain session scope, same as a native install, so
    // the path it was started from is the only thing telling the two apart.
    const appImage = _appImageIdFromPath(binaryPath);
    if (appImage)
        return {kind: 'appimage', id: appImage};

    // A flatpak launched outside a systemd scope leaves the cgroup looking
    // native, and its sandbox manifest still names it.
    const sandboxed = pid ? await _flatpakIdFromSandbox(pid) : null;
    return sandboxed ? {kind: 'flatpak', id: sandboxed} : null;
}

// Strips version, arch and build-hash tokens so the id survives an update,
// e.g. OpenRGB_1.0rc3_x86_64_6fbcf62 -> OpenRGB. The first token always stays,
// names like 4K-Video-Downloader start with a digit.
export function appImageStem(path) {
    const file = path.split('/').pop().replace(APPIMAGE_PATH_RE, '');
    const tokens = file.split(/[-_]/).filter(Boolean);
    const kept = tokens.slice(0, 1);
    for (const token of tokens.slice(1)) {
        if (/^v?\d/.test(token) || APPIMAGE_NOISE_TOKEN_RE.test(token))
            break;
        kept.push(token);
    }
    return kept.join('-') || null;
}

// Measured limit: an AppImage whose payload sets dumpable=0, as KeePassXC does,
// gives up nothing at all. Its registering process reports a bare binary name,
// denies exe and environ, and sits in the same session scope as a native
// install, so it stays keyed as native. Guessing from a sibling process would
// mislabel a real native instance running next to it.
function _appImageIdFromPath(path) {
    if (!path)
        return null;
    if (APPIMAGE_PATH_RE.test(path))
        return appImageStem(path);
    // The mount directory carries a random suffix, so the payload names the app.
    // An interpreter payload names the runtime instead, and two AppImages
    // shipping python3 would land on one key, which is worse than not splitting
    // at all. Those fall through to the interpreter handling in getProcessInfo.
    if (APPIMAGE_MOUNT_PATH_RE.test(path)) {
        const payload = path.split('/').pop();
        return payload && !GENERIC_PROCESS_NAME_RE.test(payload) ? payload : null;
    }
    return null;
}

async function _flatpakIdFromSandbox(pid) {
    const info = await readProcFile(pid, 'root/.flatpak-info');
    return info?.match(FLATPAK_INFO_NAME_RE)?.[1]?.trim() || null;
}

function _unescapeUnitName(name) {
    return name.replace(SYSTEMD_UNIT_ESCAPE_RE,
        (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
