#!/bin/sh
# Nexus sandbox setup — runs INSIDE `unshare -r -m -p -f -n` as root of a disposable user namespace.
# Trusted code: it never evaluates task input. Arguments are passed positionally and quoted.
#
# $1 base directory (host-visible while building the root)
# $2 memory bytes        $3 nproc limit       $4 file bytes
# $5 work tmpfs bytes    $6 tmp tmpfs bytes   $7 cpu seconds
# $8 open files
# $9 sandbox PATH
# $10 command            $11... arguments
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
shift 9

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

# Enter the isolated root, drop every capability and set no_new_privs, apply kernel rlimits, clear
# the environment entirely, then run the allowlisted command from the isolated checkout.
exec /usr/sbin/chroot "$root" /usr/bin/setpriv \
  --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  /usr/bin/prlimit \
  --as="$memory" --nproc="$pids" --fsize="$fsize" --cpu="$cpu" --nofile="$nofile" \
  /usr/bin/env -i \
  PATH="$sandbox_path" HOME=/work TMPDIR=/tmp CI=1 NODE_ENV=test \
  /bin/sh -c 'cd /work && exec "$@"' sh "$@"
