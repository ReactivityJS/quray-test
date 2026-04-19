LINUXKIT ?= linuxkit
IMG_DIR  := images
OUT_DIR  := output

# Service-Images (werden als Build-Stages in system/Dockerfile referenziert)
SERVICE_IMAGES := sshd ntp vmware firewall user-docker

.PHONY: all build-services build-crun build-system build-os provision-state qemu clean

all: build-os

# 1. Service-Images bauen (Reihenfolge spielt keine Rolle)
build-services:
	$(foreach s,$(SERVICE_IMAGES), \
	    docker build -t local/$(s):1.0 $(IMG_DIR)/$(s)/;)

# 2. crun Init-Layer bauen
build-crun:
	docker build -t local/crun:1.0 $(IMG_DIR)/crun/

# 3. System-Image bauen (multi-stage: extrahiert rootfs aus Service-Images)
build-system: build-services build-crun
	docker build -t local/system:1.0 $(IMG_DIR)/system/

# 4. LinuxKit OS-Image bauen → kernel + initrd
build-os: build-system
	mkdir -p $(OUT_DIR)
	$(LINUXKIT) build --docker --format kernel+initrd \
	    --name $(OUT_DIR)/lk linuxkit.yml

# 5. State-Disk anlegen (4 GB ext4, einmalig)
provision-state:
	mkdir -p $(OUT_DIR)
	dd if=/dev/zero of=$(OUT_DIR)/state.img bs=1M count=4096
	mkfs.ext4 -q -L state $(OUT_DIR)/state.img

$(OUT_DIR)/state.img:
	$(MAKE) provision-state

# 6. QEMU-Test (serielle Konsole + SSH auf Port 2222)
qemu: $(OUT_DIR)/state.img
	$(LINUXKIT) run qemu \
	    --kernel $(OUT_DIR)/lk-kernel \
	    --initrd $(OUT_DIR)/lk-initrd.img \
	    --disk $(OUT_DIR)/state.img \
	    --publish 2222:22 \
	    --mem 2048

clean:
	rm -rf $(OUT_DIR)
