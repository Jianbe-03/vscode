# syntax=docker/dockerfile:1
#---------------------------------------------------------------------------------------------
# CreaEditor Server image (Linux, amd64 or arm64).
#
# Build from the repository root:
#   docker build -f build/creaeditor-server/Dockerfile --build-arg BUILD_SOURCEVERSION=$(git rev-parse HEAD) -t creaeditor-server .
#
# The build stage uses dist/creaeditor-server-linux-<arch>.tar.gz when it exists (made with
# scripts/creaeditor-build-server.sh on Linux), else it builds that tarball from source, which
# needs about 8 GB of memory and a while. Run it with build/creaeditor-server/docker-compose.yml.
#---------------------------------------------------------------------------------------------

FROM node:24-bookworm AS build
ARG TARGETARCH
# The commit the server reports (the .git folder is not in the build context).
ARG BUILD_SOURCEVERSION=
ENV BUILD_SOURCEVERSION=$BUILD_SOURCEVERSION \
	ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
	CI=1
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git python3 make g++ pkg-config rsync \
		libkrb5-dev libx11-dev libxkbfile-dev libsecret-1-dev \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN set -eu; \
	case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "Unsupported architecture $TARGETARCH" >&2; exit 1 ;; esac; \
	tarball="dist/creaeditor-server-linux-$arch.tar.gz"; \
	if [ ! -f "$tarball" ]; then scripts/creaeditor-build-server.sh "linux-$arch"; fi; \
	mkdir -p /opt; \
	tar -xzf "$tarball" -C /opt

FROM node:24-slim
# git and gh for the agents' repositories and pull requests, ssh for git remotes over SSH.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git openssh-client ca-certificates curl gnupg \
	&& mkdir -p -m 755 /etc/apt/keyrings \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /bin/bash creaeditor \
	&& mkdir -p /data/home \
	&& chown -R creaeditor:creaeditor /data \
	&& chmod 700 /data

COPY --from=build /opt/creaeditor-server /opt/creaeditor-server

# Everything the server and its agents keep (chats, accounts, Claude and Codex logins, gh and git
# settings, secrets, repositories) lives in /data, so the volume is all there is to back up.
ENV CREAEDITOR_SERVER_DOCKER=1 \
	CREAEDITOR_SERVER_DATA_DIR=/data \
	CREAEDITOR_SERVER_PORT=31600 \
	HOME=/data/home \
	PATH=/opt/creaeditor-server/bin:$PATH

USER creaeditor
WORKDIR /data
VOLUME /data
EXPOSE 31600

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:' + (process.env.CREAEDITOR_SERVER_PORT || 31600) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["creaeditor-server"]
CMD ["serve"]
