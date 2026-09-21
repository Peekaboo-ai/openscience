# Windows SSH compute compatibility

The Windows compute connection repair covers SSH-config import, host-key scanning,
fingerprinting, connection checks, and the environment passed to job transports.

`SshAdapter.env` retains a case-normalized allowlist of Windows runtime variables,
including `PROGRAMDATA`, alongside the existing SSH-agent capability. Windows
OpenSSH 9.5 can exit with code 255 and no stderr when `PROGRAMDATA` is absent,
including for local `ssh-keygen -F` lookups. Provider credentials, executable hooks
such as `SSH_ASKPASS`/`NODE_OPTIONS`, and arbitrary environment overlays remain
excluded. Host-key checking remains strict.

SSH-config tokenization preserves drive, UNC, and relative Windows path separators.
Quoted paths can contain spaces. POSIX escaping remains unchanged. Imports still
ignore Match blocks and do not execute ProxyCommand or Match exec. Already imported
profiles whose identity path was dropped need their original identity restored or
must be reimported; correcting the parser does not invent missing credential paths.

Connection checks allow 60 seconds for authentication and login-node initialization;
the SSH connection-establishment timeout remains 8 seconds. This accommodates an
observed successful HPC login taking about 34 seconds, which exceeded the previous
12-second whole-probe deadline.

Compute settings explicitly clear the busy key in the Solid store after each
operation. Returning an object without the key merged with the previous store and
left the old `true` value intact, so tests displayed a result but stayed disabled.

Validation: backend typecheck; Windows path/import and environment regressions;
real Windows OpenSSH fingerprint computation; existing SSH argv/approval tests;
real connection check against the user's selected HPC profile. These checks do not
prove full remote job dispatch on Windows. The broader compute lifecycle suite
requires a verified sandbox backend and Unix-oriented fixtures that are unavailable
in this Windows environment.
