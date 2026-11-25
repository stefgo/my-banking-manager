# My Banking Manager: server with the built web client (image mbm-server). Reaches the FinTS
# connector (image mbm-fints) over its Unix socket; mbm-server-full has the connector inside.
FROM node:26-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY connectors/fints/package.json connectors/fints/
COPY clients/web/package.json clients/web/
# No install scripts: better-sqlite3-multiple-ciphers ships prebuilt binaries (linux x64/arm64)
# and loads them at run time; with scripts, npm would compile it with node-gyp (no Python here).
# npm 11 of this image already follows allowScripts in package.json, --ignore-scripts makes sure
# of it. esbuild finds its binary without its script as well.
RUN npm ci --ignore-scripts
COPY shared shared
COPY server server
COPY clients/web clients/web
RUN npm run build -w shared && npm run build -w server && npm run build -w clients/web \
    && npm prune --omit=dev

FROM node:26-trixie-slim
ENV NODE_ENV=production \
    MBM_DATA_DIR=/data \
    MBM_WEB_ROOT=/app/clients/web/dist \
    MBM_PORT=3040
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
COPY --from=build /app/clients/web/dist clients/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3040
# Version the server reports (set by build.yml); empty: that of server/package.json
ARG MBM_VERSION=
ENV MBM_VERSION=$MBM_VERSION
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3040/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
