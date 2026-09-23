# OpenScience desktop

## Windows Workspaces installer

Build the customized workspace as a self-contained Windows x64 NSIS installer:

```powershell
$env:OPENSCIENCE_VERSION = '2.0.127-workspaces.20260923.5'
bun run tooling/repo/build-windows-installer.ts
```

Run from the repository root after dependencies are installed. `--reuse-runtimes` skips compilation only when the matching Windows runtime and all four remote runtimes have already been built. The script checks the Windows runtime version and writes the installer and SHA-256 file under `frontend/desktop/dist/workspaces/`. No user config, credentials or sessions are included.

The English/Chinese installer runs per user without administrator access, supports choosing the installation folder, creates desktop/Start menu shortcuts, and registers an uninstaller. Launch **OpenScience Workspaces** to start the native window and its private loopback backend; Node.js and Bun are not required on the destination PC. Linux x64/ARM64 and macOS x64/ARM64 remote backends are included. SSH, WSL or Docker connections still require their respective client/host facilities. Scientific runtimes and model services are configured when needed.

The NSIS include stages an old installation alongside its original directory during upgrades. The upstream template's file-by-file rename into the system temporary directory fails when the application and temporary directory are on different drives. A failed directory rename leaves the previous installation intact; incomplete cleanup leaves the explicitly named backup for inspection.

The installer uses ZIP extraction directly into the installation directory, with extraction errors checked by the upstream NSIS template. `differentialPackage: false` must accompany `useZip: true`: electron-builder otherwise generates a 7z payload but selects the ZIP extractor. This custom Windows build uses full installer updates. Direct extraction avoids staging the entire unpacked application on the system drive. Allow at least 2 GB free on the installation drive and 1 GB for temporary files and the installer cache. When building on a machine with a nearly full system drive, set `TEMP` and `TMP` to an existing directory on a drive with enough free space for that build process.

Data, configuration, logs and browser state are stored under `%LOCALAPPDATA%\OpenScience Workspaces`, outside the installation folder. `OPENSCIENCE_WORKSPACES_HOME` can select an alternate profile. This build does not import existing development-service data automatically. Installing a new Workspaces EXE updates the application; uninstalling preserves its user data. The customized app has a distinct application ID and profile from upstream OpenScience; use matching Workspaces installers for upgrades.

Local EXE builds are unsigned unless Windows signing credentials are configured. Windows may display an unknown-publisher/SmartScreen prompt. A public trusted publisher signature requires the signing setup described below.

Before distributing an installer, install it into a disposable empty directory, then run `node frontend/desktop/script/verify-windows-install.mjs frontend/desktop/dist/workspaces/win-unpacked <installed-directory>` from the repository root. This compares every installed package file by size and SHA-256; an installer exit code alone is insufficient. Also verify desktop startup, an in-place installer update, and uninstall with profile data retained.

## Upstream desktop releases

Workspaces launches with `desktop=1&desktop-onboarding=optional` to enter the local workspace immediately, without writing onboarding completion or account state. Models and remote projects remain configured through the existing settings. Official account sign-in is optional in Settings; cloud APIs still require their own credentials. The upstream desktop entry retains its original onboarding.

The desktop shell starts the bundled OpenScience runtime on a random loopback port and opens the existing workspace in a native window. It never exposes Node APIs to the workspace.

Release builds produce:

- macOS `.dmg` installers and `.zip` self-update payloads (Apple Silicon and Intel)
- Windows NSIS `.exe`
- Linux `.AppImage`

Set `OPENSCIENCE_DESKTOP_SIDECAR` to the native runtime before running `bun run dist`. Local builds are unsigned on Windows and ad-hoc signed on macOS. Production packaging sets `OPENSCIENCE_DESKTOP_SIGNED=true`.

macOS signing uses `CSC_LINK` and `CSC_KEY_PASSWORD`; notarization additionally uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Stable production releases require those credentials and sign, notarize, and staple both the app bundle and its outer DMG installer.

Windows production packaging runs on Windows and uses Microsoft Artifact Signing with a validated Public Trust certificate profile. Set `WINDOWS_SIGNING_ENDPOINT`, `WINDOWS_SIGNING_ACCOUNT`, `WINDOWS_SIGNING_PROFILE`, and `WINDOWS_SIGNING_PUBLISHER` (the exact certificate common name). Authenticate with Azure CLI before packaging; GitHub Actions uses OIDC, without a client secret or exportable signing key. Electron Builder signs the copied sidecar, app executables, native libraries, NSIS uninstaller, and installer. The release workflow verifies Authenticode trust, publisher, and timestamps on the installer and bundled PE files before upload, and rechecks downloaded installers when resuming a release. While the Artifact Signing values are not configured in the repository, stable releases publish the Windows installer unsigned and the workflow says so in a warning. See [release setup](../../docs/notes/release-process.md#windows-signing-setup).

Only a notarized Developer ID build participates in desktop self-update. It downloads the exact architecture-specific ZIP from a published, non-prerelease GitHub release; verifies GitHub's SHA-256 digest, app identity, version, notarization, and publisher continuity; then uses the bundled signed sidecar for an atomic handoff. Stable publication keeps one packaged updater smoke on the release path; the full Apple Silicon and Intel lifecycle/rollback matrix remains available in deep CI. Ad-hoc-signed development builds remain useful for local packaging checks, but are never published as stable updater payloads and cannot self-update.
