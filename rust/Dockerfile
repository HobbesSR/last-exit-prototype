# The edge's Linux build for a deployment host (#1174, #907), for the architecture that builds it. rust/ is the
# build context; from the repository root:
#   podman build -t last-exit-edge rust    (or docker build)
# The builder tag names the same version as rust-toolchain.toml; bump both together.
FROM docker.io/library/rust:1.100.0-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --locked --release -p last-exit-edge

FROM docker.io/library/debian:bookworm-slim
COPY --from=build /src/target/release/last-exit-edge /usr/local/bin/last-exit-edge
USER nobody
ENTRYPOINT ["/usr/local/bin/last-exit-edge"]
