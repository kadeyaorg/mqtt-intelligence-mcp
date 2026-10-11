# The simulator, as a container. Build context: this directory.
#
# There is no build stage: Node runs the TypeScript source directly, so what the container
# executes is the file you can read, with no compiled artefact in between.
FROM node:25-alpine

WORKDIR /simulator

COPY package.json ./
RUN npm install --omit=dev --no-package-lock && npm cache clean --force

COPY src ./src

USER node
# Logs go to stderr, so `docker compose logs` shows them without competing with anything.
CMD ["node", "src/main.ts"]
