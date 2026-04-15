'use strict';

/**
 * Cross-platform package-manager detection + one-shot install helper.
 *
 * Used by the preflight panel's "安裝 ffmpeg" button (and any future
 * dependency that the app wants to install for the user automatically).
 *
 * Design principles
 * -----------------
 * - Never run anything with admin/root. Detecting the need for elevation
 *   and bailing early is better than silently asking the user for a
 *   password in a surprise popup.  Managers that don't need elevation
 *   (Homebrew, Scoop, winget) are preferred over ones that do
 *   (Chocolatey's `install` needs admin, apt/dnf/pacman need sudo).
 * - Stream install output line-by-line so the UI can render progress.
 *   Same pattern as venv-installer.js.
 * - Each manager entry knows: how to detect itself (``available()``),
 *   where to tell users to install it if missing (``installDocsUrl``),
 *   and how to install a given package (``buildInstallCommand``).
 */

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * @typedef {Object} PackageManagerDescriptor
 * @property {string} id          - internal key (e.g. 'brew', 'scoop')
 * @property {string} label       - human label shown in the UI
 * @property {NodeJS.Platform[]} platforms
 * @property {boolean} needsAdmin - true if the install command usually
 *   prompts for elevation; we DON'T run these, we tell the user to run
 *   them in their own terminal instead
 * @property {string} installDocsUrl - where to send the user to install
 *   the package manager itself if it's missing
 * @property {(name: string) => { command: string, args: string[] }} buildInstallCommand
 */


/** @type {PackageManagerDescriptor[]} */
const MANAGERS = [
  // --- macOS -------------------------------------------------------
  {
    id: 'brew',
    label: 'Homebrew',
    platforms: ['darwin', 'linux'],
    needsAdmin: false,
    installDocsUrl: 'https://brew.sh/',
    buildInstallCommand: (name) => ({ command: 'brew', args: ['install', name] }),
  },

  // --- Windows (admin-free first) ----------------------------------
  //
  // winget is listed before Scoop on Windows because:
  //   1. Windows 10/11 ships with winget pre-installed (App Installer),
  //      so it's almost guaranteed to be there without the user having
  //      bootstrapped Scoop themselves.
  //   2. `scoop install <pkg>` first runs a full `scoop update` across
  //      every installed bucket (main, extras, java, versions, ...),
  //      which on a user with many apps can take 5–15 minutes before
  //      the actual ffmpeg download starts — users reasonably think
  //      the install is hung.  winget's `install` hits exactly one
  //      package and typically finishes in under a minute.
  //   3. Chocolatey is kept last because its install path needs admin.
  {
    id: 'winget',
    label: 'winget',
    platforms: ['win32'],
    // winget is admin-free for per-user installs.  On first use it
    // may prompt the user to accept source agreements, but that's a
    // one-time thing and doesn't require elevation.
    needsAdmin: false,
    installDocsUrl: 'https://apps.microsoft.com/detail/9NBLGGH4NNS1',
    buildInstallCommand: (name) => ({
      command: 'winget',
      args: ['install', '--id', resolveWingetPackageId(name), '--accept-source-agreements', '--accept-package-agreements', '--silent'],
    }),
  },
  {
    id: 'scoop',
    label: 'Scoop',
    platforms: ['win32'],
    needsAdmin: false,
    installDocsUrl: 'https://scoop.sh/',
    buildInstallCommand: (name) => ({
      command: 'scoop',
      args: ['install', name],
    }),
  },
  {
    id: 'choco',
    label: 'Chocolatey',
    platforms: ['win32'],
    // Chocolatey's `install` requires admin.  We still detect it so
    // the UI can show a nice "copy command + open admin terminal"
    // option, but we don't spawn it ourselves.
    needsAdmin: true,
    installDocsUrl: 'https://chocolatey.org/install',
    buildInstallCommand: (name) => ({
      command: 'choco',
      args: ['install', name, '-y'],
    }),
  },

  // --- Linux (all need sudo) ---------------------------------------
  {
    id: 'apt',
    label: 'apt',
    platforms: ['linux'],
    needsAdmin: true,
    installDocsUrl: 'https://wiki.debian.org/Apt',
    buildInstallCommand: (name) => ({
      command: 'apt',
      args: ['install', '-y', name],
    }),
  },
  {
    id: 'dnf',
    label: 'dnf',
    platforms: ['linux'],
    needsAdmin: true,
    installDocsUrl: 'https://docs.fedoraproject.org/en-US/quick-docs/dnf/',
    buildInstallCommand: (name) => ({
      command: 'dnf',
      args: ['install', '-y', name],
    }),
  },
  {
    id: 'pacman',
    label: 'pacman',
    platforms: ['linux'],
    needsAdmin: true,
    installDocsUrl: 'https://wiki.archlinux.org/title/Pacman',
    buildInstallCommand: (name) => ({
      command: 'pacman',
      args: ['-S', '--noconfirm', name],
    }),
  },
];


/** Map our generic package names to each PM's preferred package id. */
function resolveWingetPackageId(name) {
  const map = {
    ffmpeg: 'Gyan.FFmpeg',
  };
  return map[name] || name;
}


function isExecutableOnPath(cmdName) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.BAT;.CMD;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmdName + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch (_) {
        // next
      }
    }
  }
  return null;
}


/**
 * Return the list of package managers available on this machine, in the
 * order the UI should prefer them.
 *
 * @returns {{
 *   id: string,
 *   label: string,
 *   available: boolean,
 *   needsAdmin: boolean,
 *   installDocsUrl: string,
 *   path: string | null,
 * }[]}
 */
function detectAvailableManagers() {
  return MANAGERS
    .filter((m) => m.platforms.includes(process.platform))
    .map((m) => {
      const location = isExecutableOnPath(m.id);
      return {
        id: m.id,
        label: m.label,
        available: Boolean(location),
        needsAdmin: m.needsAdmin,
        installDocsUrl: m.installDocsUrl,
        path: location,
      };
    });
}


/**
 * Install a package via the named manager.  Streams stdout/stderr line
 * chunks to ``onLog`` so the renderer can render progress.  Resolves on
 * a clean exit, rejects on a non-zero exit or spawn error.
 *
 * Refuses to spawn commands that require elevation — those return an
 * error up-front so the UI can fall back to showing the command as a
 * copy-paste for the user's own terminal.
 *
 * @param {Object} options
 * @param {string} options.managerId - one of MANAGERS[*].id
 * @param {string} options.packageName
 * @param {(chunk: string) => void} [options.onLog]
 * @returns {Promise<void>}
 */
function installPackage({ managerId, packageName, onLog }) {
  return new Promise((resolve, reject) => {
    const manager = MANAGERS.find((m) => m.id === managerId);
    if (!manager) {
      reject(new Error(`Unknown package manager: ${managerId}`));
      return;
    }
    if (!manager.platforms.includes(process.platform)) {
      reject(new Error(`${manager.label} isn't available on ${process.platform}`));
      return;
    }
    if (manager.needsAdmin) {
      reject(new Error(
        `${manager.label} requires admin privileges — please run the install command `
        + `in your own terminal instead of from WhisperFlow Studio.`,
      ));
      return;
    }
    if (!isExecutableOnPath(manager.id)) {
      reject(new Error(`${manager.label} isn't installed. See ${manager.installDocsUrl}`));
      return;
    }

    const { command, args } = manager.buildInstallCommand(packageName);
    if (typeof onLog === 'function') {
      onLog(`[${manager.label}] ${command} ${args.join(' ')}\n`);
    }

    const child = spawn(command, args, {
      env: { ...process.env, LC_ALL: 'C.UTF-8' },
      windowsHide: true,
      // Let the manager use cmd.exe / sh for us on each platform.
      shell: process.platform === 'win32',
    });

    const forward = (buf) => {
      if (typeof onLog === 'function') onLog(buf.toString('utf-8'));
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);

    child.on('error', (err) => {
      reject(new Error(`${manager.label} spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${manager.label} exited with code ${code}`));
      }
    });
  });
}


module.exports = {
  MANAGERS,
  detectAvailableManagers,
  installPackage,
};
