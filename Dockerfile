FROM node:20-bookworm-slim

# ffmpeg + fuente para los textos (cintillo y cuenta regresiva) + certificados para HTTPS.
# --no-install-recommends evita arrastrar paquetes pesados (como libllvm) que a veces fallan al instalar.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Primero las dependencias (así se reutiliza la caché si solo cambia server.js)
COPY package*.json ./
RUN npm install --omit=dev

# Luego TODO el repositorio: server.js, Canal_C.png, etc.
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
