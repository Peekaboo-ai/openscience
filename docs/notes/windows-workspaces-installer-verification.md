# Windows Workspaces installer verification

## SSH path compatibility revision

Version `2.0.127-workspaces.20260923.5` fixes the SSH `UserKnownHostsFile` argument. Even when the process receives a single argv item, OpenSSH reparses `-o` values as configuration text and splits unquoted paths at spaces. This affected both the default `OpenScience Workspaces` profile and the Chinese verification profile; the development service's path did not contain spaces.

- Reproduced the failure with system OpenSSH: it tried to open two nonexistent path fragments and reported no known ED25519 key.
- Reused the existing configuration quoting helper for the command-line value. Strict checking, saved fingerprints, and rejection of changed host keys remain unchanged.
- Added a real OpenSSH loopback handshake regression using generated keys and a Unicode/space-containing temporary directory. It fails before the fix and passes after it for both direct arguments and the inherited broker configuration. No external server or sshd is required.
- Five SSH compatibility tests, seven related config/plan/remote workspace tests, and backend typecheck passed.
- Rebuilt all five native runtimes, updated the installed desktop, and verified all 80 package files by SHA-256. The active profile, model settings, hosts, and sessions were preserved.
- The packaged desktop connected to SCNet, installed the remote backend, and received `healthy: true`, version `.20260923.5`, from the remote `/global/health` endpoint.
- During verification the connection was opened as the user's `Bio` project. Cleanup checks detected that it was now bound to a project and preserved the active connection.
- Installer delivered to `E:\Tools\OneZone`; SHA-256: `13e7878eceafde40897b987ff178956119f01aedc94a891408f0eeee32d15fd5`.

## Local workspace startup revision

Version `2.0.127-workspaces.20260923.4` removes mandatory account onboarding from the custom Workspaces entry. The upstream entry still uses its original onboarding; no account or completion records are forged or overwritten.

- 28 frontend onboarding/server-routing tests and 4 desktop URL/profile tests passed. Frontend typecheck and formatting checks passed.
- Rebuilt the Windows application and all four bundled remote runtimes.
- Installed over `.20260923.3`: exit 0; all 80 installed files matched the packaged build by size and SHA-256.
- Launched the installed desktop against a previously nonexistent Chinese profile directory. The workspace displayed Projects, Tasks, model setup and the existing research modules while `/account/session` reported `false`.
- `/global/health` reported healthy version `.20260923.4`; the existing development service on 4105 remained healthy at `.20260923.2`.
- The isolated verification window was retained. Normal shortcut launches continue using the existing default profile.
- Installer and checksum delivered to `E:\Tools\OneZone`. SHA-256: `1f8988b3d8159345046ecfaa778875b4a2ba55875226ad05d554007fb818e4b8`.

## Initial installer revision

Verified on Windows x64, 2026-09-23, application version `2.0.127-workspaces.20260923.3`.

## Failure and fix

The original ZIP installer configuration retained electron-builder 26.15.3's default differential packaging. `NsisTarget.buildAppPackage` therefore emitted 7z data while the NSIS template selected `nsisunz`. Installation failed independently of the destination directory. Set `differentialPackage: false` alongside `useZip: true`; this custom Windows build ships full installer updates.

The corrected EXE is 421,000,235 bytes. SHA-256:

```text
6227f33c0446a4b9f6cd60db55477968ee2fe9d926ef25641f47c5b21aa4543e
```

## Observed results

- Silent fresh installation into a directory containing Chinese characters and spaces: exit 0.
- All 80 installed package files, including the Windows backend and four remote runtimes, matched the unpacked build by size and SHA-256 using `frontend/desktop/script/verify-windows-install.mjs`.
- Desktop launch with a Chinese profile directory: native window displayed the upstream first-run account onboarding screen. No account authentication was performed.
- Bundled backend `/global/health`: healthy, version `2.0.127-workspaces.20260923.3`.
- Desktop quit: exit 0, test backend exited.
- In-place installation over the same version across C:/E: drives: exit 0; all 80 files matched again; profile marker remained.
- Profile unit tests: 2 passed. Changed installer config, verifier, and README passed Prettier.
- Authenticode: unsigned.
- The existing development service on port 4105 remained healthy and unchanged.

Final uninstall verification was not run: automatic tool approval rejected the test uninstaller invocation with `blocked by policy`. The test installation and isolated profile were retained. Same-version replacement was tested; a future-version upgrade and other Windows versions were not exercised.

The first-run scientific environment bootstrap could not reach the micromamba download endpoint on this machine. This did not prevent the desktop or backend starting; scientific environment setup and account onboarding are not covered by the installer smoke result.

The corrected EXE and checksum replaced the invalid copies in the user's delivery directory. Invalid installers were preserved under the task's cache for diagnosis, rather than deleted.
