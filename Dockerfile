# Garimpeiro 3D — Dockerfile
# Imagem pequena (Node 22 alpine) que roda o servidor standalone sem npm install.

FROM node:22-alpine

# sqlite precisa de libstdc++ em algumas builds; alpine tem por padrão
# Mas como Node 22+ já vem com node:sqlite experimental built-in, não precisa de python/make.

WORKDIR /app

# Copia só o que precisa (sem src/, sem node_modules)
COPY standalone.mjs ./
COPY public ./public

# Cria diretórios que o app escreve
RUN mkdir -p data logs

ENV NODE_ENV=production
ENV PORT=3040
ENV DATA_DIR=/app/data
ENV LOG_DIR=/app/logs
ENV PUBLIC_DIR=/app/public

EXPOSE 3040

# Healthcheck bate em /health a cada 30s (usa node nativo pra não depender de curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3040)+'/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "standalone.mjs"]
