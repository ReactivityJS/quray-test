LINUXKIT ?= linuxkit
OUT      := output
SYS_DIR  := images/system

# Service-Images (werden NICHT in die initrd eingebettet –
# containerd pullt/lädt sie beim ersten Boot)
SERVICE_IMAGES := sshd ntp vmware firewall user-docker

.PHONY: all build-system build-os stage-images provision-state qemu clean

all: build-os

# System-Image bauen (enthält busybox + containerd + nerdctl + Scripts)
build-system:
	docker build -t local/system:1.0 $(SYS_DIR)/

# OS-Image bauen → output/lk-kernel + output/lk-initrd.img
build-os: build-system
	mkdir -p $(OUT)
	$(LINUXKIT) build --docker --format kernel+initrd \
	    --name $(OUT)/lk linuxkit.yml

# Service-Images bauen (für die eigenen Services sshd, ntp, vmware, firewall)
build-services:
	$(foreach s,$(SERVICE_IMAGES), \
	    docker build -t local/$(s):1.0 images/$(s)/;)

# Service-Images als TARs speichern (für Offline-Bootstrap via /data/images/)
# → TARs auf den Host kopieren: scp output/images/*.tar root@host:/data/images/
stage-images: build-services
	mkdir -p $(OUT)/images
	$(foreach s,$(SERVICE_IMAGES), \
	    docker save local/$(s):1.0 -o $(OUT)/images/$(s).tar;)
	docker pull docker:26-dind
	docker save docker:26-dind -o $(OUT)/images/user-docker.tar
	@echo ""
	@echo "TARs gespeichert in $(OUT)/images/"
	@echo "Auf den Host kopieren: scp $(OUT)/images/*.tar root@HOST:/data/images/"

# State-Disk anlegen (4 GB ext4, einmalig)
provision-state:
	mkdir -p $(OUT)
	dd if=/dev/zero of=$(OUT)/state.img bs=1M count=4096
	mkfs.ext4 -q -L state $(OUT)/state.img

$(OUT)/state.img:
	$(MAKE) provision-state

# QEMU-Test (serielle Konsole + SSH auf Port 2222)
qemu: $(OUT)/state.img
	$(LINUXKIT) run qemu \
	    --kernel $(OUT)/lk-kernel \
	    --initrd $(OUT)/lk-initrd.img \
	    --disk   $(OUT)/state.img \
	    --publish 2222:22 \
	    --mem 2048

clean:
	rm -rf $(OUT)
