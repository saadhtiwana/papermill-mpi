#!/bin/bash
# Node entrypoint.
#   no arguments : sshd on port 2222 (MPI between nodes); with ROLE=master and MASTER_CMD set, also runs
#                  MASTER_CMD as mpiuser (e.g. a web front end that calls /opt/engine)
#   arguments    : run them once as mpiuser, e.g.  docker run --rm -v "$PWD/demo:/data" IMAGE /opt/engine index 0 1
set -e
mkdir -p /run/sshd /data/index
chown mpiuser:mpiuser /data /data/index 2>/dev/null || true   # directories only; input files are never touched
H=/home/mpiuser/.ssh
mkdir -p "$H"
[ -f "$H/config" ] || printf 'Host *\n    Port 2222\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n    LogLevel ERROR\n' > "$H/config"
chown -R mpiuser:mpiuser "$H" 2>/dev/null || true; chmod 700 "$H"; chmod 600 "$H"/* 2>/dev/null || true
as_mpiuser() { exec setpriv --reuid=mpiuser --regid=mpiuser --init-groups env HOME=/home/mpiuser USER=mpiuser LOGNAME=mpiuser "$@"; }
[ $# -gt 0 ] && as_mpiuser "$@"
if [ "$ROLE" = master ] && [ -n "${MASTER_CMD:-}" ]; then
    /usr/sbin/sshd -e
    as_mpiuser bash -c "$MASTER_CMD"
fi
exec /usr/sbin/sshd -D -e
