#!/usr/bin/env bash
#
# build.sh - build, test, package and deploy kan-agent (for Kan-Linux and other Linux distros).
#
# Builds the kan-agent product binary (customized Pi + the 7-tool layer + managed llama-server
# runtime) and assembles the self-contained release tree from the neighboring ggml-hexagon
# build output: llama-server plus every non-system shared library it needs, flat under bin/,
# so users can unpack one package - or build from source - and run kan-agent anywhere.
#
# Conventions (convention over configuration - see 'build.sh help'):
#   build.sh build                 build kan-agent, assemble the release tree, make the tarball
#   build.sh clean                 remove the out/ tree
#   build.sh run_check             type/lint gate (npm run check)
#   build.sh run_ut                unit + e2e test suite (./test.sh)
#   build.sh run_selftest          verify the assembled tree runs standalone (clean env)
#   build.sh ci                    run_check + run_ut + build + run_selftest
#   build.sh run_llamaserver [gguf]  start the tree's llama-server (managed-runtime baseline)
#   build.sh run_kanagent [args...]  run the built CLI, e.g.:
#                                  build.sh run_kanagent "帮我安装go"
#   build.sh deploy                install the tree to /opt/kan-agent (root; keeps llm/*.gguf)
#
set -euo pipefail

######## part-1: public macros & vars ########

PWD=$(pwd)
PROJECT_ROOT_PATH=${PWD}
HOST_CPU_COUNTS=$(cat /proc/cpuinfo | grep "processor" | wc | awk '{print int($1)}')

# The neighboring inference-engine project (ggml-hexagon) and its x86-linux build output,
# produced by its scripts/build-run-ggmlvulkan-x86-linux.sh build. Convention over configuration:
# an explicit override, a sibling checkout, or a clone inside this tree — all work.
if [ -n "${KAN_GGMLHEXAGON_PATH:-}" ]; then
    GGMLHEXAGON_PATH=${KAN_GGMLHEXAGON_PATH}
elif [ -d "${PROJECT_ROOT_PATH}/../ggml-hexagon" ]; then
    GGMLHEXAGON_PATH=${PROJECT_ROOT_PATH}/../ggml-hexagon
else
    GGMLHEXAGON_PATH=${PROJECT_ROOT_PATH}/ggml-hexagon
fi
GGMLHEXAGON_BIN=${KAN_GGMLHEXAGON_BIN:-${GGMLHEXAGON_PATH}/out/ggmlvulkan-x86-linux/bin}

# Vulkan loader location: the kan-linux SDK component, else the SDK the ggml-hexagon build used.
if [ -n "${KAN_VULKAN_LIB:-}" ]; then
    VULKAN_SDK_LIB=${KAN_VULKAN_LIB}
elif [ -f /opt/vulkan/lib/libvulkan.so.1 ]; then
    VULKAN_SDK_LIB=/opt/vulkan/lib
else
    VULKAN_SDK_LIB=$(ls -d "${GGMLHEXAGON_PATH}"/prebuilts/Vulkan_SDK/*/x86_64/lib 2>/dev/null | head -1 || true)
fi

OUT_PATH=${PROJECT_ROOT_PATH}/out
RELEASE_NAME=kan-agent
RELEASE_PATH=${OUT_PATH}/${RELEASE_NAME}
RELEASE_BIN=${RELEASE_PATH}/bin
INSTALL_PATH=/opt/kan-agent
VERSION=$(sed -n 's/^[[:space:]]*"version": "\(.*\)",\{0,1\}$/\1/p' packages/kan-agent/package.json | head -1)
TARBALL_PATH=${OUT_PATH}/${RELEASE_NAME}-${VERSION}-linux-x86_64.tar.gz

######## part-2: release layout & LLM model ########
#
# The release tree maps 1:1 onto /opt/kan-agent (HLD §4.3/§4.1):
#
#   kan-agent        product CLI - one command, no setup
#   config/          component catalog + models template (next to the CLI; the loader's convention)
#   bin/             llama-server runtime tree: llama-server + every non-system .so it resolves,
#                    flat (the Firefox-style self-contained tree). GPU driver ICDs stay
#                    system-provided - the Vulkan loader alone is bundled.
#   llm/             model dir: place exactly one .gguf here (Gemma4 today, the fine-tuned
#                    domain model later). Too big for the tarball; user-supplied.
#
# The tree is relocatable: kan-agent finds bin/llama-server and llm/ next to itself, and
# /opt/kan-agent is the installed convention.

######## part-3: utilities and functions ########

function die()
{
    printf "ERROR: %s\n" "$*" >&2
    exit 1
}

function check_command_in_host()
{
    set +e
    cmd=$1
    if command -v ${cmd} > /dev/null 2>&1; then
        printf "${cmd} is available on host machine\n"
        echo ""
    else
        printf "${cmd} not exist on host machine, pls install command line utility ${cmd} firstly and accordingly\n"
        exit 1
    fi
    set -e
}

function check_commands_in_host()
{
    check_command_in_host npm
    check_command_in_host tar
    check_command_in_host ldd
    check_command_in_host sed
}

function check_project_root()
{
    [ -f "${PROJECT_ROOT_PATH}/packages/kan-agent/package.json" ] \
        || die "run this script from the kan-agent repository root (packages/kan-agent not found)"
}

# The bun toolchain builds the standalone kan-agent binary (packages/coding-agent build:binary).
function setup_bun_path()
{
    if [ -x "${HOME}/.bun/bin/bun" ]; then
        export PATH="${HOME}/.bun/bin:${PATH}"
    fi
    if ! command -v bun > /dev/null 2>&1; then
        die "bun not found. Install it first (any one):
  npm install -g bun                  (node is part of the Kan-Linux image)
  curl -fsSL https://bun.sh/install | bash
  sudo kan-agent \"install bun\"       (from an installed release tree)"
    fi
    printf "bun is available on host machine\n\n"
}

function check_ggml_hexa_output()
{
    [ -x "${GGMLHEXAGON_BIN}/llama-server" ] || die "llama-server not found at ${GGMLHEXAGON_BIN}
Build the ggml-hexagon inference engine first (any of these layouts works):
  git clone https://github.com/kan-linux/ggml-hexagon ../ggml-hexagon    # next to this repo, or
  git clone https://github.com/kan-linux/ggml-hexagon ggml-hexagon      # inside this repo's root
  then: cd <ggml-hexagon> && ./scripts/build-run-ggmlvulkan-x86-linux.sh build
(or point KAN_GGMLHEXAGON_PATH / KAN_GGMLHEXAGON_BIN at an existing checkout)"
    [ -n "${VULKAN_SDK_LIB}" ] && [ -f "${VULKAN_SDK_LIB}/libvulkan.so.1" ] \
        || die "libvulkan.so.1 not found (looked at KAN_VULKAN_LIB, /opt/vulkan/lib, ${GGMLHEXAGON_PATH}/prebuilts/Vulkan_SDK)"
}

function build_kanagent()
{
    show_pwd
    setup_bun_path
    printf "building kan-agent standalone binary (packages/coding-agent build:binary)...\n"
    ( cd packages/coding-agent && npm run build:binary )
    [ -x packages/coding-agent/dist/kan-agent ] || die "build failed: packages/coding-agent/dist/kan-agent missing"
    printf "kan-agent binary built: packages/coding-agent/dist/kan-agent\n\n"
}

# Copy one shared library into the release bin/ under the name the loader will look for,
# then recurse into its own dependencies. System libraries (libc, libstdc++, ...) stay
# system-provided; everything resolved through the runtime trees is bundled.
function collect_runtime_deps()
{
    local target=$1
    local line needed resolved dest

    while IFS= read -r line; do
        case "${line}" in
            *"not found"*)
                die "missing shared library dependency of ${target}: ${line}"
                ;;
            *"=>"*)
                ;;
            *)
                # interpreter (ld-linux) and linux-vdso lines carry no path
                continue
                ;;
        esac
        needed=$(echo "${line%%=>*}" | tr -d ' \t')
        resolved=$(echo "${line#*=>}" | tr -d ' \t' | sed 's/(0x.*$//')
        [ -n "${needed}" ] && [ -n "${resolved}" ] || continue
        case "${resolved}" in
            /lib/*|/lib64/*|/usr/lib/*|/usr/lib64/*)
                continue
                ;;
        esac
        dest="${RELEASE_BIN}/${needed}"
        [ -e "${dest}" ] && continue
        cp -L "${resolved}" "${dest}"
        printf "  bundled %s\n" "${needed}"
        collect_runtime_deps "${dest}"
    done < <(LD_LIBRARY_PATH="${RELEASE_BIN}:${GGMLHEXAGON_BIN}:${VULKAN_SDK_LIB}" ldd "${target}")
}

function assemble_release_tree()
{
    show_pwd
    check_ggml_hexa_output

    printf "assembling release tree: ${RELEASE_PATH}\n"
    rm -rf "${RELEASE_PATH}"
    mkdir -p "${RELEASE_BIN}" "${RELEASE_PATH}/llm" "${RELEASE_PATH}/config"

    # Product binary and the files its runtime actually reads: the app manifest (piConfig ->
    # KAN_AGENT_* env prefix and branding) and the kan-agent config. pi's build artifacts (docs,
    # examples, themes, assets, export templates, README, CHANGELOG, wasm) are coding-assistant
    # surface and are deliberately not shipped.
    cp packages/coding-agent/dist/kan-agent "${RELEASE_PATH}/"
    cat > "${RELEASE_PATH}/package.json" <<EOF
{
	"name": "kan-agent",
	"version": "${VERSION}",
	"piConfig": {
		"name": "kan-agent",
		"configDir": ".pi"
	}
}
EOF
    cp packages/kan-agent/config/*.json "${RELEASE_PATH}/config/"
    printf "%s\n" "${VERSION}" > "${RELEASE_PATH}/config/VERSION"

    # llama-server runtime tree: the binary plus every non-system .so it resolves.
    cp -L "${GGMLHEXAGON_BIN}/llama-server" "${RELEASE_BIN}/"
    printf "collecting runtime shared libraries from ${GGMLHEXAGON_BIN} and ${VULKAN_SDK_LIB}...\n"
    collect_runtime_deps "${RELEASE_BIN}/llama-server"
    [ -e "${RELEASE_BIN}/libvulkan.so.1" ] \
        || die "libvulkan.so.1 was not bundled; the tree would depend on a system Vulkan loader"

    printf "release tree assembled: ${RELEASE_PATH}\n\n"
}

function make_tarball()
{
    [ -d "${RELEASE_PATH}" ] || die "release tree missing; run '$0 build' first"
    tar -czf "${TARBALL_PATH}" -C "${OUT_PATH}" "${RELEASE_NAME}"
    printf "tarball: %s\n" "${TARBALL_PATH}"
    printf "install with: sudo tar -xzf %s -C /opt/\n\n" "${TARBALL_PATH}"
}

function run_selftest()
{
    [ -d "${RELEASE_PATH}" ] || die "release tree missing; run '$0 build' first"
    printf "self-containment: llama-server with ONLY the bundled lib path...\n"
    env -i LD_LIBRARY_PATH="${RELEASE_BIN}" "${RELEASE_BIN}/llama-server" --version \
        || die "llama-server does not run standalone from ${RELEASE_BIN}"
    local missing
    missing=$(env -i LD_LIBRARY_PATH="${RELEASE_BIN}" ldd "${RELEASE_BIN}/llama-server" | grep -c "not found" || true)
    [ "${missing}" = "0" ] || die "ldd reports ${missing} unresolved libraries in the bundled tree"
    printf "CLI smoke: kan-agent --help...\n"
    "${RELEASE_PATH}/kan-agent" --help > /dev/null \
        || die "kan-agent --help failed from ${RELEASE_PATH}"
    printf "selftest OK\n\n"
}

function run_llamaserver()
{
    [ -d "${RELEASE_PATH}" ] || die "release tree missing; run '$0 build' first"
    local model_path=${1:-}
    if [ -z "${model_path}" ]; then
        model_path=$(ls "${RELEASE_PATH}/llm/"*.gguf 2>/dev/null | head -1 || true)
    fi
    [ -n "${model_path}" ] && [ -f "${model_path}" ] \
        || die "no .gguf model; place one in ${RELEASE_PATH}/llm/ or pass a path: $0 run_llamaserver <gguf>"
    # The managed-runtime baseline (HLD §4.3): same parameters kan-agent spawns with.
    printf "%s\n" "cd ${RELEASE_BIN} && ${RELEASE_BIN}/llama-server -ngl 99 -t ${HOST_CPU_COUNTS} --ctx-size 8192 --ubatch-size 64 --poll 1000 --no-warmup --load-mode none -fa on -np 1 --host 127.0.0.1 --jinja --reasoning-budget 128 --temp 0.2 --top-p 0.9 --cache-reuse 256 -m ${model_path}"
    cd "${RELEASE_BIN}" \
        && export LD_LIBRARY_PATH="${RELEASE_BIN}" \
        && export GGML_VK_ALLOW_SYSMEM_FALLBACK=1 \
        && "${RELEASE_BIN}/llama-server" -ngl 99 -t "${HOST_CPU_COUNTS}" \
             --ctx-size 8192 --ubatch-size 64 --poll 1000 --no-warmup --load-mode none -fa on -np 1 \
             --host 127.0.0.1 --jinja --reasoning-budget 128 --temp 0.2 --top-p 0.9 --cache-reuse 256 \
             -m "${model_path}"
}

function run_kanagent()
{
    [ -x "${RELEASE_PATH}/kan-agent" ] || die "release tree missing; run '$0 build' first"
    exec "${RELEASE_PATH}/kan-agent" "$@"
}

function deploy()
{
    [ -d "${RELEASE_PATH}" ] || die "release tree missing; run '$0 build' first"
    if [ "$(id -u)" -ne 0 ]; then
        die "deploy must run as root (e.g. sudo $0 deploy)"
    fi

    # User-placed models survive the reinstall; everything else is replaced.
    local gguf_backup=""
    if ls "${INSTALL_PATH}/llm/"*.gguf > /dev/null 2>&1; then
        gguf_backup=$(mktemp -d /tmp/kan-agent-llm.XXXXXX)
        cp -a "${INSTALL_PATH}/llm/"*.gguf "${gguf_backup}/"
        printf "keeping existing models from %s/llm/\n" "${INSTALL_PATH}"
    fi

    case "${INSTALL_PATH}" in
        /opt/kan-agent)
            if [ -e "${INSTALL_PATH}" ] || [ -L "${INSTALL_PATH}" ]; then
                printf "removing existing %s\n" "${INSTALL_PATH}"
                rm -rf "${INSTALL_PATH}"
            fi
            ;;
        *)
            die "refusing to remove unexpected install path: ${INSTALL_PATH}"
            ;;
    esac

    cp -a "${RELEASE_PATH}" "${INSTALL_PATH}"
    if [ -n "${gguf_backup}" ]; then
        cp -a "${gguf_backup}/"* "${INSTALL_PATH}/llm/"
        rm -rf "${gguf_backup}"
    fi

    printf "deployed: %s\n" "${INSTALL_PATH}"
    printf "run with: %s/kan-agent \"帮我安装go\"\n" "${INSTALL_PATH}"
}

function show_usage()
{
    echo -e "\n"
    echo "Usage:"
    echo "  $0 help"
    echo ""
    echo "  $0 build                 (build kan-agent + assemble release tree + tarball)"
    echo "  $0 clean                 (remove out/)"
    echo ""
    echo "  $0 run_check             (type/lint gate: npm run check)"
    echo "  $0 run_ut                (unit + e2e tests: ./test.sh)"
    echo "  $0 run_selftest          (verify the tree runs standalone in a clean env)"
    echo "  $0 ci                    (run_check + run_ut + build + run_selftest)"
    echo ""
    echo "  $0 run_llamaserver  [model.gguf]"
    echo "  $0 run_kanagent     [args...]   e.g. \"帮我安装go\""
    echo "  $0 deploy                    (install to ${INSTALL_PATH}; root; keeps llm/*.gguf)"
    echo ""
    echo "Layout of the release tree (installed to ${INSTALL_PATH}):"
    echo "  kan-agent   product CLI"
    echo "  config/     component catalog + models template"
    echo "  bin/        llama-server + bundled non-system .so (flat, self-contained)"
    echo "  llm/        place exactly one .gguf model here"
    echo ""
    echo "Env overrides:"
    echo "  KAN_GGMLHEXAGON_PATH   ggml-hexagon checkout (default: ../ggml-hexagon or ./ggml-hexagon)"
    echo "  KAN_GGMLHEXAGON_BIN    its llama-server bin dir (default: <hexagon>/out/ggmlvulkan-x86-linux/bin)"
    echo "  KAN_VULKAN_LIB         dir holding libvulkan.so.1 (default: /opt/vulkan/lib, then <hexagon>/prebuilts)"
    echo ""
    echo "Examples:"
    echo "  $0 build"
    echo "  $0 run_selftest"
    echo "  $0 ci"
    echo "  $0 run_llamaserver"
    echo "  $0 run_kanagent \"帮我安装go\""
    echo "  sudo $0 deploy"
    echo -e "\n"
}

function show_pwd()
{
    echo -e "current working path:$(pwd)\n"
}

######## part-4: entry point ########

show_pwd
check_project_root
check_commands_in_host

if [ $# -eq 0 ]; then
    show_usage
    exit 1
fi

case "$1" in
    help|-h|--help)
        show_usage
        exit 0
        ;;
    build)
        build_kanagent
        assemble_release_tree
        make_tarball
        ;;
    clean)
        rm -rf "${OUT_PATH}"
        printf "removed %s\n" "${OUT_PATH}"
        ;;
    run_check)
        npm run check
        ;;
    run_ut)
        ./test.sh
        ;;
    run_selftest)
        run_selftest
        ;;
    ci)
        npm run check
        ./test.sh
        build_kanagent
        assemble_release_tree
        make_tarball
        run_selftest
        printf "ci OK\n"
        ;;
    run_llamaserver)
        shift
        run_llamaserver "$@"
        ;;
    run_kanagent)
        shift
        run_kanagent "$@"
        ;;
    deploy)
        deploy
        ;;
    *)
        show_usage
        exit 1
        ;;
esac
