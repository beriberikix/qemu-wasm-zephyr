# QEMU WebAssembly builder image aligned with upstream CI wasm cross-container.
FROM registry.gitlab.com/qemu-project/qemu/qemu/emsdk-wasm64-cross:latest

WORKDIR /build
RUN git clone https://github.com/qemu/qemu.git

WORKDIR /build/qemu
RUN bash -lc 'set -e; \
    if [ -f /emsdk/emsdk_env.sh ]; then . /emsdk/emsdk_env.sh; fi; \
    emconfigure ./configure --disable-docs \
        --target-list=i386-softmmu \
        --static \
        --cpu=wasm64 \
        --disable-tools \
        --enable-debug \
        --enable-tcg-interpreter \
        --disable-user \
        --disable-guest-agent'

RUN bash -lc 'set -e; \
    if [ -f /emsdk/emsdk_env.sh ]; then . /emsdk/emsdk_env.sh; fi; \
    emmake make -j$(nproc)'

# Collect runtime artifacts into /artifacts to simplify host extraction.
RUN bash -lc 'set -e; \
    mkdir -p /artifacts; \
        for f in qemu-system-i386.js qemu-system-i386.wasm qemu-system-i386.worker.js bios-256k.bin kvmvapic.bin multiboot_dma.bin; do \
      src=$(find /build/qemu -type f -name "$f" | head -n 1); \
      if [ -n "$src" ]; then cp "$src" /artifacts/; fi; \
    done; \
        test -f /artifacts/qemu-system-i386.js; \
        test -f /artifacts/bios-256k.bin; \
        test -f /artifacts/kvmvapic.bin; \
        test -f /artifacts/multiboot_dma.bin'
