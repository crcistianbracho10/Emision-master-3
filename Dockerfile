# Canal C para blitz.cloud (imagen linux/amd64, corre como usuario 1000, sin permisos de administrador)
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Solo el código y el logo. NUNCA pongas contraseñas ni tokens aquí: la imagen es pública.
COPY server.js Canal_C.png ./

ENV NODE_ENV=production \
    PORT=8080 \
    FFMPEG_THREADS=2

EXPOSE 8080
USER 1000:1000
CMD ["node", "--max-old-space-size=96", "server.js"]
