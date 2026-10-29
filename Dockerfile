# ETL_GAS_STATION en Docker: el panel web, la carpeta vigilada y la línea de comandos en una sola imagen.
# La contraseña de PostgreSQL no entra a la imagen: docker compose la pasa con env_file (.env).
#
#   docker compose up -d --build            panel en http://localhost:3100
#   docker compose run --rm etl instalar-bd instala o actualiza la base (los cuatro scripts de sql/)
#   docker compose --profile vigilar up -d  además carga sola lo que se deje en entrada/

# ---------- Compilación: TypeScript a JavaScript ----------
FROM node:22-alpine AS compilacion
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---------- Imagen final: solo lo que se ejecuta ----------
# Se llama "production": es la etapa que va en "Docker Build Stage" de Dokploy (o se deja vacío: es la última)
FROM node:22-alpine AS production
# tzdata: las fechas de los tickets son hora de Guatemala; el nivel de los tanques usa la hora del contenedor
RUN apk add --no-cache tzdata
ENV NODE_ENV=production \
    TZ=America/Guatemala \
    PANEL_PUERTO=3100 \
    PANEL_ABRIR=false
WORKDIR /app
# El código queda de root (solo lectura para el proceso); las carpetas de trabajo, del usuario sin privilegios
COPY --from=compilacion /app/package.json ./
COPY --from=compilacion /app/node_modules ./node_modules
COPY --from=compilacion /app/dist ./dist
COPY panel ./panel
COPY sql ./sql
RUN mkdir -p entrada procesados rechazados && chown node:node entrada procesados rechazados
USER node
EXPOSE 3100
# Solo revisa que el panel responda (no la base: sin conexión el panel sigue sirviendo y lo avisa)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PANEL_PUERTO}/" || exit 1
# --red: escuchar en todas las interfaces del contenedor (si no, solo en su propio localhost)
CMD ["node", "dist/panel/servidor.js", "--red", "--no-abrir"]
