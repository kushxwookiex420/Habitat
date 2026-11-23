#!/bin/sh
# Nexus sandbox setup — runs INSIDE `unshare -r -m -p -f -n` as root of a disposable user namespace.
# Trusted code: it never evaluates task input. Arguments are passed positionally and quoted.
#
# $1 base directory (host-visible while building the root)
# $2 memory bytes        $3 nproc limit       $4 file bytes
# $5 work tmpfs bytes    $6 tmp tmpfs bytes   $7 cpu seconds
# $8 open files
# $9 sandbox PATH       $10 runtime dir to expose read-only (empty when it is already /usr)
# $11 resolved chroot    $12 resolved shell     $13 command  $14... arguments
set -eu

base=$1
memory=$2
pids=$3
fsize=$4
worksize=$5
tmpsize=$6
cpu=$7
nofile=$8
sandbox_path=$9
runtime_dir=${10}
chroot_bin=${11}
shell_bin=${12}
shift 12

root="$base/root"
checkout="$base/checkout"

# The only host tree exposed is read-only /usr (the runtime). No checkout, home, /etc, /var or
# docker socket is mounted, so the test cannot see or modify the host repository or credentials.
mount --bind -o ro /usr "$root/usr"
mount -t proc proc "$root/proc"
mount -t tmpfs -o "size=$tmpsize,mode=0755" tmpfs "$root/tmp"
mount -t tmpfs -o "size=$worksize,mode=0755" tmpfs "$root/work"

# Copy only the pre-selected allowlisted paths, preserving symlinks as links (they resolve inside
# this chroot, never on the host).
cp -a "$checkout/." "$root/work/"

mount -t tmpfs -o "size=4194304,mode=0755" tmpfs "$root/dev"
for node in null zero random urandom; do
  : > "$root/dev/$node"
  mount --bind "/dev/$node" "$root/dev/$node"
done

# A Node binary outside /usr (e.g. the CI tool cache) must be reachable from inside the chroot.
# Only its own bin directory is exposed, still read-only. Mounted last: a tmpfs on /tmp would
# otherwise hide a runtime that lives there.
if [ -n "$runtime_dir" ]; then
  mkdir -p "$root$runtime_dir"
  mount --bind -o ro "$runtime_dir" "$root$runtime_dir"
fi

# Enter the isolated root, drop every capability and set no_new_privs, apply kernel rlimits, clear
# the environment entirely, then run the allowlisted command from the isolated checkout.
exec "$chroot_bin" "$root" /usr/bin/setpriv \
  --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  /usr/bin/prlimit \
  --as="$memory" --nproc="$pids" --fsize="$fsize" --cpu="$cpu" --nofile="$nofile" \
  /usr/bin/env -i \
  PATH="$sandbox_path" HOME=/work TMPDIR=/tmp CI=1 NODE_ENV=test \
  "$shell_bin" -c 'cd /work && exec "$@"' sh "$@"
