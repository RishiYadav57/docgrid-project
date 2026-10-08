FROM node:20-bullseye-slim

# Install LibreOffice, Poppler (pdftoppm), fonts, and clean up apt cache
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    poppler-utils \
    fonts-liberation \
    fonts-dejavu-core \
    fontconfig \
    zip \
    unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

# Set LibreOffice environment flags for headless container operation
ENV HOME=/tmp

EXPOSE 3000

CMD ["node", "server.js"]