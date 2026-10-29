# ETL_GAS_STATION

ETL en Node.js + TypeScript que carga el reporte **"Consulta de Tickets"** de Administrativo Gasolineras (BISS) en un modelo OLAP (esquema estrella) en PostgreSQL.

El usuario exporta el reporte como siempre y se lo da al ETL tal cual. El ETL lo lee, revisa que cada suma coincida con los subtotales que imprime el propio reporte y, solo si todo cuadra, lo carga. Si algo no cuadra no entra nada y queda dicho por qué.

## Requisitos

- **Node.js 20.12 o superior** (recomendado 22 o 24 LTS). Revisa con `node -v`.
- **PostgreSQL 12 o superior** (probado en 16). Se usa el PostgreSQL de Dokploy en el servidor 72.62.80.172, base `gas_station_db`, usuario `gas_station_db`. pgAdmin es opcional.

## Instalación (una sola vez)

Abre PowerShell o el Símbolo del sistema en la carpeta del proyecto:

```powershell
cd "C:\Users\<tu usuario>\Documents\ETL_GAS_STATION"
npm install
```

1. **Pon tu contraseña en el archivo `.env`.** Si la carpeta ya trae el `.env`, ábrelo con `notepad .env`. Si no lo trae, créalo a partir de la plantilla:
   ```powershell
   copy .env.example .env
   notepad .env
   ```
   La plantilla ya trae los datos del servidor Dokploy; solo falta `PGPASSWORD`:
   ```
   PGHOST=72.62.80.172
   PGPORT=5432
   PGDATABASE=gas_station_db
   PGUSER=gas_station_db
   PGPASSWORD=la contraseña de Dokploy (Internal Credentials)
   PGSSL=false
   ```
   En el `.env` la contraseña va tal cual, con su `@`. Solo en una cadena de conexión `postgresql://...` el `@` se escribe `%40`. Si la contraseña tiene `#` o espacios al inicio o al final, escríbela entre comillas dobles: `PGPASSWORD="mi #clave"`; si tiene comillas dobles, usa comillas simples: `PGPASSWORD='mi"clave'`. Si algún día el ETL corre dentro de Dokploy, usa `PGHOST=expensesproject-gasstationdb-dt5gda`.

   Para entrar desde tu PC, en Dokploy el **External Port** debe estar en 5432 (Save y luego Deploy) y el firewall del servidor debe dejar pasar el puerto 5432, de preferencia solo desde tu IP. Para limitarlo a tu IP usa el firewall del panel del proveedor del VPS: `ufw` no filtra los puertos que publica Docker.
2. **Prueba la conexión:**
   ```powershell
   npm run probar-conexion
   ```
3. **Instala la base de datos:**
   ```powershell
   npm run instalar-bd
   ```
   La base `gas_station_db` ya existe en Dokploy, así que solo le crea las tablas, funciones y vistas del ETL. Se puede volver a ejecutar cuando quieras: no borra datos. Si el nombre de `PGDATABASE` no existe en el servidor, avisa y no crea nada; en un servidor nuevo (que no sea Dokploy) se puede crear con `npm run instalar-bd -- --crear-base`.

**Si prefieres hacerlo desde pgAdmin:** registra el servidor 72.62.80.172, puerto 5432, usuario `gas_station_db`, abre el Query Tool sobre la base `gas_station_db`, carga `sql/instalar_base_de_datos.sql` y ejecútalo (F5). Con psql:

```powershell
psql -h 72.62.80.172 -p 5432 -U gas_station_db -d gas_station_db -v ON_ERROR_STOP=1 -f sql/instalar_base_de_datos.sql
```

O con la cadena de conexión (el `@` de la contraseña va como `%40`):

```
postgresql://gas_station_db:TU_CONTRASEÑA@72.62.80.172:5432/gas_station_db
```

`sql/00_crear_base_de_datos.sql` solo hace falta para montar la base en otro servidor que no sea Dokploy.

## Con Docker (otra forma de instalarlo)

Se dockeriza solo la aplicación (panel, carga y carpeta vigilada); la base de datos sigue siendo el PostgreSQL de la nube (Dokploy). Solo hace falta Docker Desktop (o Docker en un servidor); no hace falta instalar Node.js. Se usa el mismo `.env` de esta carpeta: la contraseña no entra a la imagen, Compose la pasa al contenedor.

```powershell
docker compose up -d --build                       # panel en http://localhost:3100
docker compose run --rm etl instalar-bd            # instala o actualiza la base (los cuatro scripts de sql/)
docker compose run --rm etl probar-conexion
docker compose run --rm etl cargar "entrada/DATA_TICKETS_DESPACHOS.xlsx"
docker compose --profile vigilar up -d             # también la carpeta vigilada: carga lo que se deje en entrada/
docker compose logs -f panel                       # ver lo que pasa
docker compose down                                # apagar
```

- Las carpetas `entrada`, `procesados` y `rechazados` de esta carpeta se comparten con el contenedor: los archivos quedan en tu PC. Con Docker deja las rutas del `.env` relativas (`ETL_CARPETA_ENTRADA=entrada`); una ruta de Windows como `C:\...` no existe dentro del contenedor.
- El panel solo se abre desde esta PC (`127.0.0.1`). Para abrirlo desde otras PCs de una red de confianza, cambia en `docker-compose.yml` la línea de `ports` por `"3100:3100"`. Si el 3100 ya está ocupado (por ejemplo, por `npm run panel`), usa otro: `$env:PANEL_PUERTO_HOST=3200; docker compose up -d`.
- El contenedor usa la hora de Guatemala (`TZ=America/Guatemala`), la misma de los tickets y del nivel de los tanques.
- Sin un nombre en el panel, las cargas quedan a nombre de `node` (el usuario del contenedor): pon `ETL_USUARIO` en el `.env` o escribe tu nombre en el panel.
- En Dokploy se puede desplegar con este mismo `docker-compose.yml`; ahí `PGHOST` puede ser el nombre interno de la base: `expensesproject-gasstationdb-dt5gda`.

## Uso

### 1. Exportar el reporte en BISS

Consulta de Tickets, en **Detalle**, Estatus **Todos**, sin filtros, por rango de turnos, a Excel (.xlsx).

### 2. Cargarlo desde el panel web (lo más fácil)

```powershell
npm run panel
```

También funciona `npm run dev`. Se abre el navegador en **http://localhost:3100**. Deja abierta la ventana de PowerShell mientras usas el panel; con Ctrl+C se cierra.

- **Cargar reporte:** arrastra el `.xlsx` a la zona punteada (o haz clic para buscarlo). El panel lo revisa sin tocar la base y muestra qué trae (tickets, periodo, turnos, venta), qué pasará en la base (tickets nuevos, los que se actualizan y qué campo cambia, los que quedan iguales, los que pierden su factura), el cuadre contra los subtotales del reporte, la revisión de calidad, gráficas por día, producto, turno y facturación, y la tabla de tickets con filtros y búsqueda. El archivo puede pesar hasta 50 MB. **Nada entra hasta que presionas "Cargar a la base".** El archivo cargado se guarda en `procesados` (o en `rechazados`) con su `.json`, igual que con la carpeta vigilada.
- **Dashboard:** indicadores y gráficas (Apache ECharts) de lo que ya está en el modelo: ventas por día y por producto, utilidad por galón, mapa de calor por día y hora, ventas por turno, facturación, los 10 clientes con código que más compran, tickets para revisar y tickets que faltan. Se filtra por fechas, estación y producto, y cada gráfica tiene el botón "Ver tabla". Los indicadores se comparan con el periodo anterior solo cuando ese periodo está cargado completo, y el mapa de calor muestra el promedio por día.
- **Historial de cargas:** las últimas 100 cargas (del panel o de la consola), con su revisión de calidad, el cuadre y lo que cambió en cada carga.

Revisar un archivo funciona aunque no haya conexión a la base; si falta la conexión, el panel lo avisa arriba con el motivo y qué hacer. Si cambias el `.env`, cierra el panel y vuelve a abrirlo.

En el `.env` se puede cambiar el puerto (`PANEL_PUERTO`, por defecto 3100) y evitar que abra el navegador solo (`PANEL_ABRIR=false`). Para abrirlo desde otra PC de la misma red: `npm run panel -- --red` (muestra la dirección a usar). Cualquiera en esa red podría cargar archivos, así que úsalo solo en una red de confianza.

### Compras, toma física e inventario (versión 1.1.0)

**Actualizar la base (una sola vez):** ejecuta `sql/actualizar_compras_inventario.sql` en pgAdmin (Query Tool sobre `gas_station_db`, F5), o `npm run instalar-bd` (que ahora corre los dos scripts en orden). Solo agrega tablas, funciones y vistas: no cambia ni borra nada de los tickets.

- **Reporte de compras:** se sube en el mismo lugar que la Consulta de Tickets (panel, `npm run cargar` o carpeta `entrada`). El ETL reconoce cuál es por sus columnas (Serie, Numero, Cantidad, FOB, CIF) y corre el ETL de compras: valida, cuadra contra los subtotales y el total del reporte y carga a `dw.fact_compra`, una fila por factura y producto. El reporte no trae la estación: usa la opción Estación del panel o `ETL_ESTACION_POR_DEFECTO`. Volver a subir un periodo no duplica nada. Los lubricantes se guardan, pero solo Diesel, Regular y Super entran al inventario; las compras anuladas no suman.
- **Toma física:** la pestaña **Tomas físicas** es el mantenimiento completo: registrar lo que marcan los tanques (fecha y hora de la medición, galones de cada producto), buscar por estación, fechas, producto y estado, editar fecha, hora, galones u observaciones, anular y restaurar. Nada se borra, y cada cambio queda en la bitácora de la toma (`dw.toma_fisica_historial`, con el valor anterior y el nuevo). La edición y la bitácora necesitan `sql/actualizar_tomas_fisicas.sql` (versión 1.2.0; `npm run instalar-bd` lo incluye).
- **Inventario:** eliges estación y rango de fechas y ves, por producto, la existencia inicial, las compras, las ventas y la existencia final, la existencia al cierre de cada día, las compras del periodo y cada toma física contra lo que debía haber (faltante o sobrante). La existencia de cualquier momento sale de la toma física más cercana (`mart.existencia_en`): con una sola toma el panel calcula hacia adelante y hacia atrás con las compras y las ventas cargadas. Sin ninguna toma de un producto, su existencia no se puede saber.

### 3. O cargarlo desde la consola

```powershell
npm run cargar -- "C:\Users\<tu usuario>\Documents\REPORTS_DIAGNOSTICS\DATA_TICKETS_DESPACHOS.xlsx"
```

Se pueden pasar varios archivos seguidos. El resultado se ve así:

```
DATA_TICKETS_DESPACHOS.xlsx: CARGADO (carga 2) en 2.4 s
  3,441 tickets nuevos, 180 actualizados y 2,456 sin cambio
  Hoja "Consulta de Tickets", encabezado en la fila 2, 29 columnas
  Tickets leídos: 6,077 de PCONC, turnos 765 a 787, del 01/10/2026 07:15 al 23/10/2026 21:48
  Total Q810,084.21 · 20,470.67046 galones
  Cuadre contra el reporte: 5 grupos, 40 comparaciones, todo cuadra
  Incidencias: 0 errores, 7 advertencias, 251 informativas
    ADVERTENCIA TICKET_FALTANTE (3)
      - Falta el ticket 243283 en PCONC
  ...
```

Para revisar un archivo **sin cargarlo** (no necesita la base de datos):

```powershell
npm run validar -- "C:\ruta\archivo.xlsx"
```

Las exportaciones viejas que no traen la columna Estación usan `ETL_ESTACION_POR_DEFECTO` del `.env`, o la que indiques con `--estacion "PCONC - GASOLINERA CONCEPCION LAS MINAS"`.

### 4. O dejarlo en una carpeta (carga automática)

```powershell
npm run vigilar
```

Deja los `.xlsx` en la carpeta `entrada`. Cada archivo se carga y se mueve a `procesados` o a `rechazados`, con un `.json` al lado que dice qué pasó. Se detiene con Ctrl+C. Los archivos se toman del más viejo al más nuevo.

Para el Programador de tareas de Windows, `npm run vigilar -- --una-vez` revisa la carpeta una vez y termina. Termina con código 0 si todo entró (o ya estaba cargado), 1 si rechazó algún archivo y 2 si no pudo procesar alguno (por ejemplo, sin conexión a la base o un archivo vacío); en ese caso lo deja en `entrada` para la siguiente vez. Un archivo que todavía se está copiando se deja para la siguiente vuelta sin contar como error. Así la tarea aparece como fallida cuando algo no entró.

### Cada cuánto subir el reporte

Lo recomendado es exportar cada día (o cada semana) **repitiendo los 3 o 4 días anteriores**. Las facturas globales se emiten días después y así quedan actualizadas en el modelo. Volver a subir un período no duplica nada: cada ticket se busca por estación + número y solo se actualiza lo que cambió.

**El último archivo manda.** Si cargas una exportación vieja después de una nueva, los tickets vuelven a los valores viejos; si con eso una factura desaparece, la carga lo avisa como `FACTURA_QUITADA`. Sube siempre la exportación más reciente al final.

## Qué pasa con cada archivo

| Estado | Qué significa |
|---|---|
| CARGADO | Pasó todas las validaciones, cuadró y entró al modelo |
| RECHAZADO | Tiene al menos un error. **No entra nada**; el motivo queda en `etl.incidencia` |
| DUPLICADO | Ese mismo archivo ya se había cargado; no se procesa otra vez |

**Errores** (rechazan el archivo): no se encuentra el encabezado, falta una columna obligatoria, una fila con forma desconocida, un ticket repetido, una fecha o un número que no se puede leer, falta la estación, tickets sin su fila de subtotal (archivo cortado) o una suma que no cuadra con el subtotal o el total del reporte.

**Advertencias** (el archivo entra y queda el aviso): una fórmula del ticket que no se cumple, ticket sin producto, producto distinto a su sección, precio fuera del pricebook, posible ticket duplicado, huecos en la numeración, un ticket ya cargado que no vino, una factura que desapareció.

**Informativas:** venta bajo costo, NIT que no pasa el dígito verificador, columna nueva que el ETL no conoce.

## Dónde quedan los datos

| Esquema | Qué tiene |
|---|---|
| `etl` | Control: `v_cargas` (historial), `carga`, `incidencia`, `cuadre`, `cambio` (bitácora de lo que cambió entre cargas) |
| `stg` | Los tickets tal como vinieron en cada archivo (se guardan `ETL_DIAS_STAGING` días) |
| `dw` | La estrella: `fact_despacho` (un renglón por ticket, partición por año) y sus dimensiones de fecha, hora, turno, estación, bomba, producto, cliente, pricebook y tipo de venta |
| `mart` | Para consultar y para Power BI: `v_despacho` (vista ancha), `v_resumen_mensual`, `mv_ventas_diarias`, `mv_ventas_turno`, `v_alertas_ticket`, `v_tickets_faltantes`, `v_tramos_precio_costo`, `v_clientes_revision` |
| 1.1.0 | `stg.compra`, `dw.dim_proveedor`, `dw.fact_compra`, `dw.toma_fisica`, `dw.cargar_compras()`, `mart.existencia_en(estacion_key, producto_key, momento)`, `mart.v_compra`, `mart.v_toma_fisica_diferencia` |
| 1.2.0 | `dw.toma_fisica.modificada_en / modificada_por`, `dw.toma_fisica_historial` y su trigger `dw.registrar_cambio_toma()` |
| 1.3.0 | `dw.tanque`: capacidad de cada combustible por estación y parámetros de pedido (entrega, reserva, mínimo, llenado máximo, múltiplo, horizonte, días de consumo) |

**Nivel de los tanques (Inventario):** un medidor por combustible con el porcentaje de ocupación y bandas de semáforo, el galonaje actual (estimado a esta hora si las ventas cargadas terminan antes), la capacidad, cuántos días alcanza y la recomendación: *Orden urgente*, *Ordenar pronto*, *Programar orden en N días* o *Estable*, con el pedido sugerido en múltiplos de 500 gal. *Revisar existencia* sale cuando el cálculo da negativo o más que la capacidad (una toma o una compra mal registrada). La capacidad y los parámetros se escriben en "Configurar tanques".

En `sql/consultas_olap_ejemplo.sql` hay consultas listas: historial de cargas, incidencias, ROLLUP, CUBE, GROUPING SETS, mapa de calor por hora y día, turno contra día, ventas sin factura por NIT y descuentos por pricebook.

## Estructura del proyecto

```
ETL_GAS_STATION/
  .env                       tus credenciales (no se comparte)
  .env.example               plantilla del .env
  sql/
    instalar_base_de_datos.sql   script completo de la base (se puede repetir)
    00_crear_base_de_datos.sql   crear el usuario del ETL y la base a mano (opcional; en Dokploy no hace falta)
    consultas_olap_ejemplo.sql   consultas de ejemplo
  src/
    cli.ts                   comandos
    config.ts                lectura del .env
    db.ts                    conexión a PostgreSQL
    lector/excel.ts          abre el .xlsx y resuelve celdas combinadas
    reportes/consulta-tickets/
      encabezado.ts          ubica el encabezado y mapea columnas por nombre (acepta "Poducto")
      clasificador.ts        sección, ticket, subtotal, total
      conversion.ts          números exactos, fechas dd/mm/aaaa AM/PM, textos
      reglas.ts              reglas de calidad
      cuadre.ts              suma contra subtotales y total del reporte
      index.ts               lectura completa del reporte
    carga/
      registro.ts            etl.carga, sha256, incidencias y cuadre
      staging.ts             COPY a stg.ticket_despacho
      publicar.ts            dw.cargar_tickets() y refresco de mart
      cargar.ts              la carga de un archivo de principio a fin
      vigilar.ts             carpeta vigilada
    bd/instalar.ts           instalar-bd y probar-conexion
    panel/
      servidor.ts            servidor web del panel (npm run panel)
      api.ts                 rutas /api: estado, vista previa, carga, dashboard, historial
      vistaPrevia.ts         revisión del archivo subido y comparación con la base
      consultas.ts           consultas del dashboard sobre mart y dw
  panel/                     la página del panel: index.html, estilos.css y js/ (gráficas con Apache ECharts)
  test/                      pruebas con reportes de ejemplo inventados
```

## Problemas comunes

| Mensaje | Qué hacer |
|---|---|
| El .env todavía tiene la contraseña de ejemplo / Falta la contraseña | Pon en `PGPASSWORD` la contraseña de Dokploy (Internal Credentials) |
| Usuario o contraseña incorrectos | Revisa `PGUSER` y `PGPASSWORD` en el `.env` (la contraseña con su `@`, no `%40`; entre comillas si tiene `#`) |
| El servidor no responde (se agotó el tiempo de espera) | En Dokploy guarda el External Port 5432 y dale Deploy; abre el puerto 5432 en el firewall del servidor |
| No hay un PostgreSQL escuchando | En Dokploy revisa que el External Port esté guardado y desplegado y que la base esté corriendo (Start o Reload); revisa `PGHOST` y `PGPORT` en el `.env` |
| La base de datos "..." no existe | Revisa `PGDATABASE` en el `.env`: en Dokploy es `gas_station_db`. En un servidor nuevo: `npm run instalar-bd -- --crear-base` |
| No tiene permiso para crear bases de datos | Revisa `PGDATABASE`; en Dokploy la base ya existe y no hace falta `--crear-base` |
| No se encuentra el servidor / No hay ruta hacia el servidor | Revisa `PGHOST` en el `.env` y tu conexión a internet |
| El servidor cerró (o cortó) la conexión | Revisa que `PGPORT` sea el de PostgreSQL y que la base esté corriendo en Dokploy |
| El servidor no acepta conexión cifrada | Pon `PGSSL=false` en el `.env` |
| PostgreSQL se está iniciando o reiniciando / se reinició o se detuvo | Espera a que termine el Deploy en Dokploy y vuelve a intentar; lo que se estaba cargando no quedó a medias |
| Algo en esta PC bloquea la conexión | Permite la salida al puerto 5432 en el firewall o antivirus de Windows |
| La base no tiene las tablas del ETL | `npm run instalar-bd` |
| El archivo no se pudo abrir como Excel .xlsx | Expórtalo otra vez desde BISS en formato .xlsx |
| No encuentro el archivo | Pon la ruta completa entre comillas |
| No puedo abrir el archivo: está abierto en otro programa | Cierra el archivo en Excel y vuelve a intentar |
| No conozco la opción ... / La opción ... está mal escrita | Revisa cómo escribiste la opción (por ejemplo `--crear-base`, `--una-vez`, `--estacion "..."`); el mensaje muestra la ayuda |
| ... está vacío (0 bytes) | La exportación se cortó: borra el archivo de `entrada` y exporta el reporte otra vez |
| El puerto 3100 ya está en uso | El panel ya está abierto en otra ventana: abre http://localhost:3100. O pon otro puerto en `PANEL_PUERTO` del `.env` |
| Petición no permitida (en el panel) | Abre el panel con http://localhost:3100, no con el nombre o la IP de la PC (para eso está `npm run panel -- --red`) |
| La vista previa ya no está disponible | Pasaron más de 30 minutos o se cerró el panel: sube el archivo otra vez |
| PowerShell dice que la ejecución de scripts está deshabilitada | Usa `npm.cmd` en lugar de `npm` (por ejemplo `npm.cmd run cargar -- "archivo.xlsx"`) o el Símbolo del sistema |

## Para desarrollo

```powershell
npm test            # pruebas
npm run typecheck   # revisión de tipos
npm run build       # compila a dist/; luego: node dist/cli.js cargar "archivo.xlsx"
```

Probado con PostgreSQL 16, base y usuario `gas_station_db`, y las dos exportaciones reales de octubre 2026: turnos 764 a 774 (2,747 tickets) y luego turnos 765 a 787 (3,441 nuevos, 180 actualizados porque se les asignó factura después, 2,456 sin cambio). Los totales del modelo coinciden al centavo con el reporte: 6,077 tickets, Q810,084.21, costo Q697,870.685668153 y utilidad Q112,183.524331847.
