#!/bin/sh
. /usr/local/lib/init/bootstrap-utils.sh
img_ensure sshd local/sshd:1.0 || exit 0
ctr_run sshd \
    --name sshd \
    --net host \
    --cap-add NET_BIND_SERVICE --cap-add SETUID --cap-add SETGID \
    --cap-add CHOWN --cap-add DAC_READ_SEARCH --cap-add AUDIT_WRITE \
    -v /data/ssh:/data/ssh \
    local/sshd:1.0 \
    /usr/sbin/sshd -D -e \
        -h /data/ssh/ssh_host_ed25519_key \
        -h /data/ssh/ssh_host_rsa_key \
        -o AuthorizedKeysFile=/data/ssh/authorized_keys
