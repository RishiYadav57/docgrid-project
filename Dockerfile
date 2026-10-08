FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/tmp

RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-nogui \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    poppler-utils \
    fonts-liberation \
    fonts-dejavu-core \
    fontconfig \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
ENV HOME=/tmp

EXPOSE 3000

CMD ["node", "server.js"]
