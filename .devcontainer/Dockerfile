FROM node:24.22.3-bookworm

RUN useradd -m -s /bin/bash vscode
RUN mkdir -p /workspaces && chown -R vscode:vscode /workspaces
WORKDIR /workspaces
