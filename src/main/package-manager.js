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
  // On Windows, delegate to `where.exe` first because it correctly
  // resolves App Execution Aliases in %LOCALAPPDATA%\Microsoft\WindowsApps
  // (how Windows 10/11 expose `winget.exe` and other Store-provided
  // binaries).  These aliases are APPEXECLINK reparse points and
  // `fs.statSync(...).isFile()` returns false on them, so the manual
  // PATH walk below silently misses winget even when the user has it
  // installed.  The `where` invocation uses the OS's canonical
  // resolver and catches these cases correctly.  Falls back to the
  // manual walk if `where` errors out (e.g. the command isn't on
  // PATH — extremely unusual, but not worth crashing over).
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where', [cmdName], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString('utf-8').trim();
      if (out) {
        // `where` can print multiple results (one per line).  Take
        // the first one — that's what Windows itself would launch.
        const first = out.split(/\r?\n/)[0]?.trim();
        if (first) return first;
      }
    } catch (_) {
      // Not found via `where`, or `where` itself unavailable — fall
      // through to the manual PATH walk.
    }
  }

  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.BAT;.CMD;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmdName + ext);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) {
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
// Holds the currently running install child process so `cancelActiveInstall`
// can kill it from another IPC call.  Only one install runs at a time (the
// dialog enforces that), so a single module-level slot is enough.
let _activeChild = null;
let _activeCancelled = false;

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
    _activeChild = child;
    _activeCancelled = false;

    // Accumulate the full output so we can scan it for known-failure
    // patterns after the child closes.  Some package managers (Scoop
    // in particular) exit 0 on genuine failures — we can't trust
    // exit code alone and have to grep the output ourselves.
    let accumulatedOutput = '';
    const forward = (buf) => {
      const text = buf.toString('utf-8');
      accumulatedOutput += text;
      if (typeof onLog === 'function') onLog(text);
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);

    child.on('error', (err) => {
      if (_activeChild === child) _activeChild = null;
      reject(new Error(`${manager.label} spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      const wasCancelled = _activeCancelled;
      if (_activeChild === child) {
        _activeChild = null;
        _activeCancelled = false;
      }
      if (wasCancelled) {
        const err = new Error(`${manager.label} install cancelled by user`);
        err.code = 'PM_INSTALL_CANCELLED';
        reject(err);
        return;
      }

      // Scan the accumulated output for known-failure patterns before
      // trusting the exit code.  Scoop's 7z wrapper reports extraction
      // failures on stderr but still lets the outer `scoop install`
      // exit 0, which is how the infamous `ffmpeg decompress-error`
      // issue bypasses naive exit-code-only success checks.  winget's
      // `--silent` mode has a similar bug around UAC cancellation.
      const failureReason = detectSilentInstallFailure(managerId, accumulatedOutput);
      if (failureReason) {
        const err = new Error(
          `${manager.label} reported success but the output contains a failure marker: ${failureReason}`,
        );
        err.code = 'PM_SILENT_FAILURE';
        reject(err);
        return;
      }

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${manager.label} exited with code ${code}`));
      }
    });
  });
}

/**
 * Scan the combined stdout+stderr of a finished package-manager run
 * for known failure signatures that the manager didn't propagate as
 * a non-zero exit code.  Returns a short human-readable reason
 * string if a silent failure is detected, or `null` otherwise.
 *
 * This list is additive — add new entries as we find new silent-
 * failure modes in the wild, but keep the existing ones stable so
 * we don't regress the detection.
 */
function detectSilentInstallFailure(managerId, output) {
  if (!output || typeof output !== 'string') return null;
  const text = output;

  if (managerId === 'scoop') {
    // 7z decompress error — Scoop exits 0 but ffmpeg isn't extracted.
    // Example line:
    //   "Failed to extract files from C:\...\ffmpeg-8.1-full_build.7z."
    if (/Failed to extract files from/i.test(text)) {
      return '7z extraction failed (scoop decompress-error)';
    }
    // Scoop's boilerplate "Please try again or create a new issue"
    // footer is only printed on failure paths even though the outer
    // exit code can still be 0.
    if (/Please try again or create a new issue/i.test(text)) {
      return 'scoop install reported a user-facing failure';
    }
    // Checksum mismatch — also exits 0 in some Scoop versions.
    if (/Hash check failed|ERROR Hash check failed/i.test(text)) {
      return 'scoop hash check failed';
    }
  }

  if (managerId === 'winget') {
    // winget occasionally reports "Installer failed with exit code"
    // in stdout while the outer winget process itself exits 0.
    if (/Installer failed with exit code/i.test(text)) {
      return 'winget installer subprocess reported failure';
    }
    // User cancelled UAC — winget prints this on stderr and exits 0
    // with --silent in some builds.
    if (/The operation was cancell?ed by the user/i.test(text)) {
      return 'UAC prompt cancelled by user';
    }
  }

  if (managerId === 'choco') {
    if (/The install of .* was NOT successful/i.test(text)) {
      return 'chocolatey reported install was not successful';
    }
  }

  return null;
}

/**
 * Kill the currently running install child (if any).  Returns true if a
 * process was actually killed, false if there was nothing to cancel.
 *
 * On Windows we walk the process tree via `taskkill /T` because scoop /
 * winget are PowerShell front-ends that spawn their real work as
 * grandchildren — a plain `child.kill()` only kills the shim and leaves
 * the download running in the background.  On POSIX a plain SIGTERM is
 * enough because `spawn(..., { shell: false })` gives us the real pid.
 */
function cancelActiveInstall() {
  const child = _activeChild;
  if (!child || child.killed) return false;
  _activeCancelled = true;
  try {
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      // /F force, /T tree — kills the shell and every descendant spawned
      // by scoop / winget / choco.
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch (_) {
        // Fall through to child.kill() as a best-effort fallback.
        child.kill();
      }
    } else {
      child.kill('SIGTERM');
      // Escalate to SIGKILL after a grace period so a misbehaving child
      // that ignores SIGTERM still goes down.
      setTimeout(() => {
        if (_activeChild === child && !child.killed) {
          try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        }
      }, 2000);
    }
  } catch (_) {
    return false;
  }
  return true;
}


module.exports = {
  MANAGERS,
  detectAvailableManagers,
  installPackage,
  cancelActiveInstall,
};
