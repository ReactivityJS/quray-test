#!/bin/sh
# DinD-Container für Docker Swarm und User-Workloads
. /usr/local/lib/init/bootstrap-utils.sh
img_ensure user-docker docker:26-dind || exit 0
ctr_run user-docker \
    --name user-docker \
    --net host \
    --privileged \
    -v /data/docker:/var/lib/docker \
    -v /var/run:/var/run \
    docker:26-dind \
    dockerd \
        --host unix:///var/run/docker.sock \
        --storage-driver overlay2 \
        --data-root /var/lib/docker
