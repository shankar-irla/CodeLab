FROM eclipse-temurin:25-jdk-noble

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin codelab \
    && mkdir -p /workspace \
    && chown codelab:codelab /workspace

USER 10001:10001
WORKDIR /workspace
