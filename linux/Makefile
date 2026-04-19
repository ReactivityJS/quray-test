LINUXKIT ?= linuxkit
OUT      := output
SYS_DIR  := images/system
LK_NAME  := $(OUT)/lk
LK_ARGS  := --docker --name $(LK_NAME) linuxkit.yml

SERVICE_IMAGES := sshd ntp vmware firewall user-docker

.PHONY: all build-system \
        build-kernel build-iso build-efi build-vmware build-qcow2 build-vhd \
        build-all \
        build-services stage-images \
        provision-state run-qemu run-vmware \
        push clean

# ── Standardziel: alle relevanten Formate ────────────────────────────────────
all: build-all

# ── System-Docker-Image (Basis für alle Formate) ─────────────────────────────
build-system:
	docker build -t local/system:1.0 $(SYS_DIR)/

# ── LinuxKit-Formate (einzeln) ───────────────────────────────────────────────
build-kernel: build-system
	mkdir -p $(OUT)
	$(LINUXKIT) build $(LK_ARGS) --format kernel+initrd

build-iso: build-system
	mkdir -p $(OUT)
	$(LINUXKIT) build $(LK_ARGS) --format iso-bios

build-efi: build-system
	mkdir -p $(OUT)
	$(LINUXKIT) build $(LK_ARGS) --format iso-efi

build-vmware: build-system
	mkdir -p $(OUT)
	$(LINUXKIT) build $(LK_ARGS) --format vmware

build-qcow2: build-system
	mkdir -p $(OUT)
	$(LINUXKIT) build $(LK_ARGS) --format qcow2

build-vhd: build-system
	mkdir -p $(OUT)
	$(LINUXKIT) build $(LK_ARGS) --format vhd

# ── Alle Formate in einem Durchlauf ─────────────────────────────────────────
# Erzeugt: lk-kernel, lk-initrd.img, lk.iso (BIOS+EFI), lk.vmdk, lk.qcow2
build-all: build-system
	mkdir -p $(OUT)
	$(LINUXKIT) build $(LK_ARGS) \
	    --format kernel+initrd \
	    --format iso-bios \
	    --format iso-efi \
	    --format vmware \
	    --format qcow2

# ── Service-Images bauen + als TARs bereitstellen (Offline-Bootstrap) ────────
build-services:
	$(foreach s,$(SERVICE_IMAGES), \
	    docker build -t local/$(s):1.0 images/$(s)/;)

stage-images: build-services
	mkdir -p $(OUT)/images
	$(foreach s,$(SERVICE_IMAGES), \
	    docker save local/$(s):1.0 -o $(OUT)/images/$(s).tar;)
	docker pull docker:26-dind
	docker save docker:26-dind -o $(OUT)/images/user-docker.tar
	@echo ""
	@echo "TARs in $(OUT)/images/ – auf den Host kopieren:"
	@echo "  scp $(OUT)/images/*.tar root@HOST:/data/images/"

# ── State-Disk (einmalig für lokale Tests) ───────────────────────────────────
provision-state:
	mkdir -p $(OUT)
	dd if=/dev/zero of=$(OUT)/state.img bs=1M count=4096
	mkfs.ext4 -q -L state $(OUT)/state.img

$(OUT)/state.img:
	$(MAKE) provision-state

# ── Lokale Tests ─────────────────────────────────────────────────────────────
run-qemu: $(OUT)/state.img
	$(LINUXKIT) run qemu \
	    --kernel $(LK_NAME)-kernel \
	    --initrd $(LK_NAME)-initrd.img \
	    --disk   $(OUT)/state.img \
	    --publish 2222:22 \
	    --mem 2048

# VMware-VMDK direkt in vSphere/ESXi importieren:
#   govc import.vmdk $(LK_NAME).vmdk [datastore-path]
# Oder lokal mit VMware Fusion/Workstation öffnen.
run-vmware:
	@echo "VMDK: $(LK_NAME).vmdk"
	@echo "In vSphere: govc import.vmdk $(LK_NAME).vmdk"
	@echo "Lokal:      vmware $(LK_NAME).vmdk  (VMware Fusion/Workstation)"

clean:
	rm -rf $(OUT)
