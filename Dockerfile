# QEMU WebAssembly builder image aligned with upstream CI wasm cross-container.
FROM registry.gitlab.com/qemu-project/qemu/qemu/emsdk-wasm64-cross:latest

# Pinned for reproducible builds; bump deliberately.
ARG QEMU_REF=812798d
WORKDIR /build
RUN git clone https://github.com/qemu/qemu.git && git -C qemu checkout ${QEMU_REF}

WORKDIR /build/qemu
# Emscripten's poll(), when proxied from a thread (QEMU runs on one), always
# returns a Promise, even with a zero timeout; with -sASYNCIFY that aborts
# ("_emscripten_receive_on_main_thread_js was not in ASYNCIFY_IMPORTS"). Make
# it answer synchronously. QEMU's qemu_poll_ns() (patched below) never asks
# poll() to wait; it sleeps on its own thread instead.
RUN f=/emsdk/upstream/emscripten/src/lib/libsyscall.js \
 && sed -i "s/^  __syscall_poll__async: 'auto',$//" $f \
 && sed -i "s/const isAsyncContext = PThread.currentProxiedOperationCallerThread;/const isAsyncContext = false;/" $f \
 && ! grep -q "__syscall_poll__async" $f \
 && grep -q "const isAsyncContext = false;" $f

# Patches for running under Emscripten; see each patch for why.
COPY patches/ /build/patches/
RUN git apply --verbose /build/patches/*.patch

RUN bash -lc 'set -e; \
    if [ -f /emsdk/emsdk_env.sh ]; then . /emsdk/emsdk_env.sh; fi; \
    emconfigure ./configure --disable-docs \
        --target-list=i386-softmmu \
        --static \
        --cpu=wasm64 \
        --disable-tools \
        --disable-debug-info \
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
