#!/bin/sh
. /usr/local/lib/init/bootstrap-utils.sh
img_ensure vmware local/vmware:1.0 || exit 0
ctr_run vmware \
    --name vmware \
    --net host \
    --privileged \
    -v /proc:/proc \
    -v /sys:/sys \
    -v /dev:/dev \
    local/vmware:1.0 \
    /usr/bin/vmtoolsd
