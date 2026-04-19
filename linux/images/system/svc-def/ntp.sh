#!/bin/sh
. /usr/local/lib/init/bootstrap-utils.sh
img_ensure ntp local/ntp:1.0 || exit 0
ctr_run ntp \
    --name ntp \
    --net host \
    --cap-add SYS_TIME --cap-add NET_BIND_SERVICE \
    local/ntp:1.0 \
    /usr/sbin/chronyd -d -f /etc/chrony/chrony.conf
