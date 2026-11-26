# My Banking Manager: server with the built web client and both connectors inside its process
# (image mbm-server-full). One container, no socket: the server calls the connectors directly
# (MBM_FINTS_EMBEDDED=1, MBM_ENABLEBANKING_EMBEDDED=1). The FinTS connector reaches out only to the
# banks, the Enable Banking connector only to api.enablebanking.com (HTTPS), and only once a user
# sets up a PSD2 access. MBM_ENABLEBANKING_EMBEDDED=0 at run time leaves Enable Banking out.
FROM node:26-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY connectors/fints/package.json connectors/fints/
COPY connectors/enablebanking/package.json connectors/enablebanking/
COPY clients/web/package.json clients/web/
# No install scripts: better-sqlite3-multiple-ciphers ships prebuilt binaries (linux x64/arm64)
# and loads them at run time; with scripts, npm would compile it with node-gyp (no Python here).
# npm 11 of this image already follows allowScripts in package.json, --ignore-scripts makes sure
# of it. esbuild finds its binary without its script as well.
RUN npm ci --ignore-scripts
COPY shared shared
COPY server server
COPY connectors/fints connectors/fints
COPY connectors/enablebanking connectors/enablebanking
COPY clients/web clients/web
RUN npm run build -w shared && npm run build -w server && npm run build -w connectors/fints \
    && npm run build -w connectors/enablebanking && npm run build -w clients/web && npm prune --omit=dev
# FinTS product registration number, only for the official images: the registration terms allow it
# inside the registered product, never in the source. It comes as a build secret (not a build
# argument, which would stay readable in the image history):
#   docker build --build-arg MBM_FINTS_OFFICIAL=1 --secret id=fints_product_id,env=FINTS_PRODUCT_ID \
#       -f docker/server-full.Dockerfile .
# Without the secret, the image has no number and takes it from MBM_FINTS_PRODUCT_ID at run time.
# The secret is not part of the build cache key: MBM_FINTS_OFFICIAL keeps the cached layers of
# official and other builds apart, and an official build fails without the secret.
ARG MBM_FINTS_OFFICIAL=
RUN --mount=type=secret,id=fints_product_id,required=false \
    if [ -n "$MBM_FINTS_OFFICIAL" ] && [ ! -s /run/secrets/fints_product_id ]; then \
        echo "Official build without the secret fints_product_id" >&2; exit 1; \
    fi; \
    if [ -n "$MBM_FINTS_OFFICIAL" ]; then \
        tr -d ' \t\r\n' < /run/secrets/fints_product_id > connectors/fints/dist/product-id; \
    fi

FROM node:26-trixie-slim
ENV NODE_ENV=production \
    MBM_DATA_DIR=/data \
    MBM_WEB_ROOT=/app/clients/web/dist \
    MBM_PORT=3040 \
    MBM_FINTS_EMBEDDED=1 \
    MBM_ENABLEBANKING_EMBEDDED=1
WORKDIR /app
# License and notice (NOTICE: the FinTS product ID of official images is not under MIT)
COPY LICENSE NOTICE ./
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
# Bank directory of the Bundesbank (public data)
COPY --from=build /app/server/data-static server/data-static
COPY --from=build /app/connectors/fints/package.json connectors/fints/
COPY --from=build /app/connectors/fints/dist connectors/fints/dist
COPY --from=build /app/connectors/enablebanking/package.json connectors/enablebanking/
COPY --from=build /app/connectors/enablebanking/dist connectors/enablebanking/dist
COPY --from=build /app/clients/web/dist clients/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3040
# Version the server and the connectors report (set by build.yml); empty: that of their package.json
ARG MBM_VERSION=
ENV MBM_VERSION=$MBM_VERSION
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3040/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
