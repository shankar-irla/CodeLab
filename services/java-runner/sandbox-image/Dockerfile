FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-21-jdk-headless coreutils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/bash codelab \
    && mkdir -p /workspace \
    && chown -R codelab:codelab /workspace

WORKDIR /workspace
USER codelab
