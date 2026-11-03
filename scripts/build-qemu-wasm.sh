#!/bin/bash

# Script to automate building QEMU for WebAssembly.
# Default mode builds in Docker for reproducibility, with optional native fallback.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WEB_DIR="$PROJECT_ROOT/web"
DOCKER_IMAGE="qemu-wasm-builder:latest"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[info]${NC} $*"; }
log_success() { echo -e "${GREEN}[✓]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
log_error() { echo -e "${RED}[error]${NC} $*"; exit 1; }

# Check common required tools
check_common_requirements() {
    log_info "Checking requirements..."
    
    if ! command -v git &> /dev/null; then
        log_error "git is not installed"
    fi
    
    if ! command -v python3 &> /dev/null; then
        log_error "python3 is not installed"
    fi
    
    log_success "Requirements met"
}

# Check additional requirements for native builds
check_native_requirements() {
    log_info "Checking native build dependencies..."

    local missing_deps=()
    for cmd in bzip2 flex bison pkg-config make; do
        if ! command -v "$cmd" &> /dev/null; then
            missing_deps+=("$cmd")
        fi
    done
    
    if [ ${#missing_deps[@]} -gt 0 ]; then
        log_warn "Missing build dependencies: ${missing_deps[*]}"
        log_info "Install with: sudo apt install ${missing_deps[*]}"
        log_error "Please install missing dependencies and try again"
    fi

    log_success "Native build dependencies met"
}

# Setup or update Emscripten SDK
setup_emsdk() {
    local emsdk_dir="${1:-.emsdk}"
    
    log_info "Setting up Emscripten SDK..."
    
    if [ ! -d "$emsdk_dir" ]; then
        log_info "Cloning emsdk..."
        git clone https://github.com/emscripten-core/emsdk.git "$emsdk_dir"
    fi
    
    cd "$emsdk_dir"
    
    log_info "Installing latest Emscripten..."
    ./emsdk install latest > /dev/null 2>&1 || true
    
    log_info "Activating Emscripten..."
    ./emsdk activate latest > /dev/null 2>&1 || true
    
    cd - > /dev/null
    
    log_success "Emscripten SDK ready"
}

# Clone or update QEMU repository
setup_qemu_repo() {
    local qemu_dir="${1:-qemu}"
    
    log_info "Setting up QEMU repository..."
    
    if [ ! -d "$qemu_dir" ]; then
        log_info "Cloning QEMU..."
        git clone https://github.com/qemu/qemu.git "$qemu_dir"
    else
        log_info "Updating QEMU repository..."
        cd "$qemu_dir"
        git fetch origin > /dev/null 2>&1 || true
        cd - > /dev/null
    fi
    
    log_success "QEMU repository ready"
}

# Build QEMU for WebAssembly natively
build_qemu_wasm_native() {
    local qemu_dir="${1:-qemu}"
    local emsdk_dir="${2:-.emsdk}"
    
    # Source Emscripten environment
    log_info "Sourcing Emscripten environment..."
    source "$emsdk_dir/emsdk_env.sh" > /dev/null 2>&1 || log_error "Failed to source emsdk_env.sh"
    
    # Set PKG_CONFIG_PATH for system packages
    export PKG_CONFIG_PATH="/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig:${PKG_CONFIG_PATH}"
    
    cd "$qemu_dir"

    # The same QEMU patches the Docker build applies (see patches/).
    local patch
    for patch in "$PROJECT_ROOT"/patches/*.patch; do
        if git apply --check "$patch" 2>/dev/null; then
            git apply "$patch" && log_success "Applied $(basename "$patch")"
        elif git apply --reverse --check "$patch" 2>/dev/null; then
            log_info "Already applied: $(basename "$patch")"
        else
            log_error "Cannot apply $(basename "$patch") to this QEMU tree"
        fi
    done
    log_warn "Native builds do not patch Emscripten's poll(); if the page stops at"
    log_warn "'Starting QEMU' with an ASYNCIFY_IMPORTS abort, use --docker (see README)."

    log_info "Configuring QEMU for WebAssembly..."
    log_info "This may take a few minutes..."
    
    if ! emconfigure ./configure \
        --cpu=wasm64 \
        --target-list=i386-softmmu \
        --enable-system \
        --enable-tcg-interpreter \
        --disable-plugins \
        --extra-cflags="-sUSE_ZLIB=1 -I/usr/include/x86_64-linux-gnu" \
        --extra-ldflags="-sUSE_ZLIB=1" \
        --disable-user \
        --disable-docs \
        --disable-tools \
        --disable-guest-agent \
        > /dev/null 2>&1; then
        log_info "Configuration output:"
        emconfigure ./configure \
            --cpu=wasm64 \
            --target-list=i386-softmmu \
            --enable-system \
            --enable-tcg-interpreter \
            --disable-plugins \
            --extra-cflags="-sUSE_ZLIB=1 -I/usr/include/x86_64-linux-gnu" \
            --extra-ldflags="-sUSE_ZLIB=1" \
            --disable-user \
            --disable-docs \
            --disable-tools \
            --disable-guest-agent 2>&1 | tail -20
        log_error "QEMU configuration failed"
    fi
    
    log_success "Configuration complete"
    
    log_info "Building QEMU (this will take 10-30 minutes)..."
    local num_jobs=$(nproc)
    log_info "Using $num_jobs parallel jobs..."
    
    emmake make -j"$num_jobs" > /dev/null 2>&1 || log_error "QEMU build failed"
    
    log_success "QEMU build complete"
    
    cd - > /dev/null
}

# Build QEMU for WebAssembly in Docker
build_qemu_wasm_docker() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Use --native or install Docker."
    fi

    log_info "Building QEMU WebAssembly in Docker..."
    log_info "This can take 15-30 minutes the first time."

    docker build -t "$DOCKER_IMAGE" -f "$PROJECT_ROOT/Dockerfile" "$PROJECT_ROOT" || \
        log_error "Docker image build failed"

    local cid
    cid=$(docker create "$DOCKER_IMAGE")
    trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT

    mkdir -p "$WEB_DIR"
    for file in qemu-system-i386.js qemu-system-i386.wasm bios-256k.bin kvmvapic.bin multiboot_dma.bin; do
        docker cp "$cid:/artifacts/$file" "$WEB_DIR/$file" || \
            log_error "Missing artifact in Docker image: $file"
        log_success "Copied $file"
    done

    if docker cp "$cid:/artifacts/qemu-system-i386.worker.js" "$WEB_DIR/qemu-system-i386.worker.js" 2>/dev/null; then
        log_success "Copied qemu-system-i386.worker.js"
    else
        log_warn "qemu-system-i386.worker.js not found (continuing without pthread worker)"
    fi

    docker rm -f "$cid" >/dev/null 2>&1 || true
    trap - EXIT
}

resolve_artifacts_dir() {
    local qemu_dir="$1"
    local found
    found=$(find "$qemu_dir" -type f -name qemu-system-i386.js 2>/dev/null | head -n 1 || true)
    if [ -z "$found" ]; then
        return 1
    fi
    dirname "$found"
}

resolve_bios_file() {
    local qemu_dir="$1"
    local found
    found=$(find "$qemu_dir" -type f -name bios-256k.bin 2>/dev/null | head -n 1 || true)
    if [ -z "$found" ]; then
        return 1
    fi
    echo "$found"
}

resolve_rom_file() {
    local qemu_dir="$1"
    local rom_name="$2"
    local found
    found=$(find "$qemu_dir" -type f -name "$rom_name" 2>/dev/null | head -n 1 || true)
    if [ -z "$found" ]; then
        return 1
    fi
    echo "$found"
}

# Copy artifacts to web directory
copy_artifacts() {
    local qemu_dir="${1:-qemu}"
    local artifacts_dir
    local bios_file
    local kvmvapic_file
    local multiboot_dma_file

    artifacts_dir=$(resolve_artifacts_dir "$qemu_dir") || \
        log_error "QEMU wasm artifacts not found in $qemu_dir"
    bios_file=$(resolve_bios_file "$qemu_dir") || \
        log_error "bios-256k.bin not found in $qemu_dir"
    kvmvapic_file=$(resolve_rom_file "$qemu_dir" "kvmvapic.bin") || \
        log_error "kvmvapic.bin not found in $qemu_dir"
    multiboot_dma_file=$(resolve_rom_file "$qemu_dir" "multiboot_dma.bin") || \
        log_error "multiboot_dma.bin not found in $qemu_dir"
    
    log_info "Copying artifacts to web directory..."
    
    for file in qemu-system-i386.js qemu-system-i386.wasm; do
        if [ -f "$artifacts_dir/$file" ]; then
            cp "$artifacts_dir/$file" "$WEB_DIR/"
            log_success "Copied $file"
        else
            log_warn "Missing $file"
        fi
    done

    cp "$bios_file" "$WEB_DIR/bios-256k.bin"
    log_success "Copied bios-256k.bin"
    cp "$kvmvapic_file" "$WEB_DIR/kvmvapic.bin"
    log_success "Copied kvmvapic.bin"
    cp "$multiboot_dma_file" "$WEB_DIR/multiboot_dma.bin"
    log_success "Copied multiboot_dma.bin"

    if [ -f "$artifacts_dir/qemu-system-i386.worker.js" ]; then
        cp "$artifacts_dir/qemu-system-i386.worker.js" "$WEB_DIR/"
        log_success "Copied qemu-system-i386.worker.js"
    else
        log_warn "qemu-system-i386.worker.js not found (optional)"
    fi
    
    log_success "Artifacts copied to $WEB_DIR"
}

# Main script
main() {
    log_info "QEMU WebAssembly Build Script"
    log_info "==============================="
    
    check_common_requirements
    
    # Parse arguments
    EMSDK_DIR="${EMSDK_DIR:-.emsdk}"
    QEMU_DIR="${QEMU_DIR:-qemu}"
    SKIP_EMSDK=0
    SKIP_BUILD=0
    BUILD_MODE="auto"
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --emsdk-dir)
                EMSDK_DIR="$2"
                shift 2
                ;;
            --qemu-dir)
                QEMU_DIR="$2"
                shift 2
                ;;
            --skip-emsdk)
                SKIP_EMSDK=1
                shift
                ;;
            --skip-build)
                SKIP_BUILD=1
                shift
                ;;
            --docker)
                BUILD_MODE="docker"
                shift
                ;;
            --native)
                BUILD_MODE="native"
                shift
                ;;
            --help)
                echo "Usage: $0 [options]"
                echo ""
                echo "Options:"
                echo "  --emsdk-dir DIR       Path to Emscripten SDK (default: .emsdk)"
                echo "  --qemu-dir DIR        Path to QEMU repository (default: qemu)"
                echo "  --skip-emsdk          Skip Emscripten setup"
                echo "  --skip-build          Skip QEMU build (just copy artifacts)"
                echo "  --docker              Build with Docker"
                echo "  --native              Build natively with emsdk"
                echo "  --help                Show this help message"
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                ;;
        esac
    done
    
    # Create absolute paths
    EMSDK_DIR="$(cd "$(dirname "$EMSDK_DIR")" && pwd)/$(basename "$EMSDK_DIR")"
    QEMU_DIR="$(cd "$(dirname "$QEMU_DIR")" && pwd)/$(basename "$QEMU_DIR")" 2>/dev/null || QEMU_DIR="$(pwd)/$QEMU_DIR"
    
    log_info "Emscripten SDK: $EMSDK_DIR"
    log_info "QEMU repo: $QEMU_DIR"
    log_info "Output: $WEB_DIR"
    log_info "Build mode: $BUILD_MODE"
    echo ""

    if [ "$BUILD_MODE" = "docker" ] || { [ "$BUILD_MODE" = "auto" ] && command -v docker &> /dev/null; }; then
        build_qemu_wasm_docker
    else
        check_native_requirements
        if [ $SKIP_EMSDK -eq 0 ]; then
            setup_emsdk "$EMSDK_DIR"
            echo ""
        fi

        setup_qemu_repo "$QEMU_DIR"
        echo ""

        if [ $SKIP_BUILD -eq 0 ]; then
            build_qemu_wasm_native "$QEMU_DIR" "$EMSDK_DIR"
            echo ""
        fi

        copy_artifacts "$QEMU_DIR"
    fi
    echo ""
    
    log_success "✓ QEMU WebAssembly build complete!"
    echo ""
    log_info "Next steps:"
    echo "  1. Run the Zephyr firmware build:"
    echo "     cd $PROJECT_ROOT && ./scripts/build.sh"
    echo ""
    echo "  2. Start the development server:"
    echo "     ./scripts/dev.sh --port 8080"
    echo ""
    echo "  3. Open http://localhost:8080 in your browser"
}

main "$@"
