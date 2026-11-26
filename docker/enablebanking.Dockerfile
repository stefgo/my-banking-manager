# My Banking Manager: Enable Banking connector (image mbm-enablebanking), PSD2 account information
# through Enable Banking. No port, no data on disk: it listens on a Unix socket in a tmpfs volume
# that only the server mounts as well, and reaches out only to api.enablebanking.com (HTTPS).
# Application ID and key of each user come with every call from the server.
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
COPY connectors/enablebanking connectors/enablebanking
RUN npm run build -w shared && npm run build -w connectors/enablebanking

FROM node:26-trixie-slim
ENV NODE_ENV=production \
    MBM_ENABLEBANKING_SOCKET=/run/mbm/enablebanking.sock
WORKDIR /app
COPY LICENSE NOTICE ./
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY connectors/fints/package.json connectors/fints/
COPY connectors/enablebanking/package.json connectors/enablebanking/
COPY clients/web/package.json clients/web/
# Only what the connector needs at run time
RUN npm ci --omit=dev --workspace=connectors/enablebanking --workspace=shared && npm cache clean --force
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/connectors/enablebanking/dist connectors/enablebanking/dist
USER node
# Version the connector reports (set by build.yml); empty: that of its package.json
ARG MBM_VERSION=
ENV MBM_VERSION=$MBM_VERSION
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "require('http').get({socketPath:process.env.MBM_ENABLEBANKING_SOCKET,path:'/v1/info'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "connectors/enablebanking/dist/index.js"]
