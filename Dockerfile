FROM node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS node_runtime
FROM mcr.microsoft.com/playwright@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 3200 4200
CMD ["npm", "start"]
