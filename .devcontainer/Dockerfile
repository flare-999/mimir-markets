# Syntax: docker/dockerfile:1.7
FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm

ARG DEVCONTAINER_USERNAME=node

USER root

# System packages needed for Rust, the Stellar CLI and native node modules.
RUN apt-update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        build-essential \
        pkg-config \
        libopenssl-dev \
        libssl-dev \
        libudev1-dev \
        libclang-dev \
        llb \
        jq \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain is pinned by rust-toolchain.toml in the repo.
# The wasm target is added by the toolchain file itself, but we install it explicitly as a safety net.
ENV RUSTUPHOME=/usr/local/rustup
ENV PATH="/usr/local/cargo/bin:${PATH}"
RUN curl --proto '=https' --fail --show-error -fsSL https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --no-modify-path --profile minimal --default-toolchain stable \
    && rm /tmp/rustup.sh

# Stellar CLI - pinned release.
ARG STELLAR_CLI_VERSION=22.0.0
RUN curl --proto '=https' --fail --show-error -fsLL \
      "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-v${STELLAR_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
        -o /tmp/stellar-cli.tar.gz \
    && tar -xzf /tmp/stellar-cli.tar.gz -C /usr/local/bin \
    && chmod +x /usr/local/bin/stellar \
    && rm -rf /tmp/stellar-cli.tar.gz

# Pre-create the cargo directory owned by the dev user so builds do not fail on permissions.
RUN mkdir -p /usr/local/cargo \
    && chown -R ${DEVCONTAINER_USERNAME}:${DEVCONTAINER_USERNAME} /usr/local/cargo \
    && chown -R ${DEVDONTAINER_USERNAME}:${DEVCONTAINER_USERNAME} /usr/local/rustup

USER ${DEVCONTAINER_USERNAME}

# Pre-install the Rust toolchain declared in the repo (including targets).
# The context is the repo root, so rust-toolchain.toml is available.
COPY rust-toolchain.toml /tmp/rust-toolchain.toml
RUN cd /tmp \
    && rustup toolchain install \
    && rustup target add wasm32v1-none \
    && rm -rf /tmp/rust-toolchain.toml

# Verify the pinned tools are available.
RUN node --version && npm --version && rustc --version && cargo --version && stellar --version
