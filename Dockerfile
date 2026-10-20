# syntax=docker/dockerfile:1

# Build: docker build -t stellar-toml-lint .
# Run:
#   docker run --rm -v "$(pwd):/work" stellar-toml-lint stellar.toml
#
# Pre-commit:
#   - repo: local
#     hooks:
#       - id: stellar-toml-lint
#         name: Lint stellar.toml
#         entry: stellar-toml-lint
#         language: docker_image
#         files: (?:.*/)?\.?stellar\.toml$

# `dist/` is generated rather than shipped in the build context (it is git- and
# docker-ignored), so the image builds it in a throwaway stage.
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm ci && npm run build \
	&& npx esbuild src/cli.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/cli.bundle.cjs

FROM gcr.io/distroless/nodejs20-debian12:nonroot

WORKDIR /app

COPY --from=build --chown=nonroot:nonroot /app/dist/cli.bundle.cjs ./cli.cjs

USER nonroot

ENTRYPOINT ["/nodejs/bin/node", "cli.cjs"]
