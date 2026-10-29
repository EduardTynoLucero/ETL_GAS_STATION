-- =====================================================================
-- ETL_GAS_STATION: instalación del modelo OLAP (esquemas etl, stg, dw y mart) en la base gas_station_db
-- Reporte "Consulta de Tickets" de Administrativo Gasolineras (BISS)
--
-- Requiere PostgreSQL 12 o superior (probado en 16).
-- Se ejecuta conectado a la base gas_station_db con el usuario gas_station_db
-- (servidor Dokploy 72.62.80.172, puerto 5432). La base ya existe en Dokploy;
-- este script solo crea los esquemas, tablas, funciones y vistas del ETL:
--   * con el ETL:   npm run instalar-bd   (usa los datos del .env)
--   * con pgAdmin:  Query Tool sobre la base gas_station_db, abrir este archivo y ejecutar (F5)
--   * con psql:     psql -h 72.62.80.172 -p 5432 -U gas_station_db -d gas_station_db -v ON_ERROR_STOP=1 -f sql/instalar_base_de_datos.sql
--
-- Se puede ejecutar las veces que haga falta: no borra datos ni duplica nada.
--
-- Capas
--   etl  : control de cargas, incidencias, cuadres y bitácora de cambios
--   stg  : los tickets tal como salen del Excel, ya tipados, con su fila de origen
--   dw   : dimensiones y tabla de hechos (la estrella)
--   mart : vistas y vistas materializadas para consultar
-- =====================================================================

SET client_encoding = 'UTF8';

BEGIN;

CREATE SCHEMA IF NOT EXISTS etl;
CREATE SCHEMA IF NOT EXISTS stg;
CREATE SCHEMA IF NOT EXISTS dw;
CREATE SCHEMA IF NOT EXISTS mart;

-- ---------------------------------------------------------------------
-- etl: control de cargas
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS etl.version_esquema (
    version       text PRIMARY KEY,
    instalado_en  timestamptz NOT NULL DEFAULT now(),
    descripcion   text
);

CREATE TABLE IF NOT EXISTS etl.carga (
    carga_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tipo_reporte     text        NOT NULL DEFAULT 'CONSULTA_TICKETS',
    archivo_nombre   text        NOT NULL,
    archivo_sha256   char(64)    NOT NULL,
    archivo_bytes    bigint      NOT NULL,
    variante         jsonb,                 -- columnas detectadas, en su orden; si traía Estación
    usuario          text,
    estado           text        NOT NULL DEFAULT 'RECIBIDO'
                     CHECK (estado IN ('RECIBIDO', 'VALIDADO', 'CARGADO', 'RECHAZADO', 'DUPLICADO')),
    iniciado_en      timestamptz NOT NULL DEFAULT now(),
    terminado_en     timestamptz,
    estacion_codigo  text,
    turno_min        int,
    turno_max        int,
    fecha_min        timestamp,
    fecha_max        timestamp,
    filas_detalle    int,
    insertadas       int,
    actualizadas     int,
    sin_cambio       int,
    rechazadas       int,
    mensaje          text
);
-- El mismo archivo no se carga dos veces
CREATE UNIQUE INDEX IF NOT EXISTS ux_carga_archivo_cargado
    ON etl.carga (tipo_reporte, archivo_sha256) WHERE estado = 'CARGADO';

CREATE TABLE IF NOT EXISTS etl.incidencia (
    incidencia_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    carga_id       bigint NOT NULL REFERENCES etl.carga ON DELETE CASCADE,
    fila_excel     int,
    ticket_numero  bigint,
    severidad      text   NOT NULL CHECK (severidad IN ('ERROR', 'ADVERTENCIA', 'INFO')),
    regla          text   NOT NULL,
    columna        text,
    valor          text,
    mensaje        text   NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_incidencia_carga ON etl.incidencia (carga_id, severidad);

-- Suma de los tickets leídos contra los subtotales y el total que imprime el propio reporte
CREATE TABLE IF NOT EXISTS etl.cuadre (
    carga_id       bigint  NOT NULL REFERENCES etl.carga ON DELETE CASCADE,
    grupo          text    NOT NULL,       -- DIESEL, REGULAR, SUPER, (sin sección), TOTAL GENERAL
    medida         text    NOT NULL,       -- cantidad, total, total_neto, costo_total, utilidad...
    tickets        int     NOT NULL,
    suma_detalle   numeric NOT NULL,
    valor_reporte  numeric NOT NULL,
    tolerancia     numeric NOT NULL,       -- media unidad del último decimal que imprime el reporte
    cuadra         boolean GENERATED ALWAYS AS (abs(suma_detalle - valor_reporte) <= tolerancia) STORED,
    PRIMARY KEY (carga_id, grupo, medida)
);

-- Bitácora de cambios: qué cambió de un ticket o de un cliente entre una carga y otra
CREATE TABLE IF NOT EXISTS etl.cambio (
    cambio_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    carga_id        bigint NOT NULL REFERENCES etl.carga ON DELETE CASCADE,
    entidad         text   NOT NULL,       -- TICKET, CLIENTE
    llave           text   NOT NULL,       -- PCONC-243576, C20092024014
    campo           text   NOT NULL,
    valor_anterior  text,
    valor_nuevo     text
);
CREATE INDEX IF NOT EXISTS ix_cambio_carga ON etl.cambio (carga_id, entidad);

-- ---------------------------------------------------------------------
-- stg: un renglón por ticket leído del Excel
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stg.ticket_despacho (
    carga_id           bigint  NOT NULL REFERENCES etl.carga ON DELETE CASCADE,
    fila_excel         int     NOT NULL,
    seccion            text,               -- encabezado de grupo del reporte (DIESEL, REGULAR, SUPER)
    estacion           text    NOT NULL,   -- 'PCONC - GASOLINERA CONCEPCION LAS MINAS' o la elegida al subir
    turno              int     NOT NULL,
    ticket             bigint  NOT NULL,
    bomba              int,
    servicio           text,
    credito            text,
    factura_serie      text,
    factura_numero     text,
    fecha_hora         timestamp NOT NULL, -- hora local de Guatemala (UTC-6, sin horario de verano)
    cliente_codigo     text,
    cliente_nit        text,
    cliente_nombre     text,
    vale               text,
    producto           text,
    cantidad           numeric(14,5),
    precio_despacho    numeric(12,4),
    precio_lista       numeric(12,4),
    iva                numeric(18,6),
    idp                numeric(18,6),
    descuento          numeric(18,9),
    total              numeric(14,2),
    total_neto         numeric(18,6),
    costo_total        numeric(20,9),
    costo_unitario     numeric(12,4),
    utilidad           numeric(20,9),
    utilidad_pct       numeric(9,4),
    utilidad_unitario  numeric(14,6),
    pricebook          text,
    plan_fidelidad     text,
    PRIMARY KEY (carga_id, fila_excel)
);

-- ---------------------------------------------------------------------
-- dw: dimensiones (llave -1 = "no definido", para que ningún hecho quede sin dimensión)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dw.dim_fecha (
    fecha_key         int PRIMARY KEY,      -- aaaammdd
    fecha             date UNIQUE,
    anio              smallint,
    trimestre         smallint,
    mes               smallint,
    nombre_mes        text,
    anio_mes          text,                 -- '2026-10'
    semana_iso        smallint,
    dia               smallint,
    dia_semana        smallint,             -- 1 = lunes ... 7 = domingo
    nombre_dia        text,
    es_fin_de_semana  boolean,
    es_feriado        boolean NOT NULL DEFAULT false,
    nombre_feriado    text
);

CREATE TABLE IF NOT EXISTS dw.dim_hora (
    hora_key    smallint PRIMARY KEY,       -- minuto del día, 0 a 1439
    hora        smallint,
    minuto      smallint,
    hora_texto  text,                       -- '08:56'
    rango_hora  text,                       -- '08:00-08:59'
    franja      text                        -- Madrugada, Mañana, Tarde, Noche
);

CREATE TABLE IF NOT EXISTS dw.dim_estacion (
    estacion_key  int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    codigo        text NOT NULL UNIQUE,     -- PCONC
    nombre        text NOT NULL,
    bandera       text,                     -- datos que no trae el reporte: se llenan una vez
    empresa       text,
    municipio     text,
    departamento  text,
    activa        boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS dw.dim_turno (
    turno_key         int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    estacion_key      int  NOT NULL REFERENCES dw.dim_estacion,
    numero            int  NOT NULL,
    primer_ticket_en  timestamp,
    ultimo_ticket_en  timestamp,
    fecha_operativa   date,                 -- día con más tickets del turno; la reemplaza la del cierre de caja cuando se cargue ese reporte
    cruza_medianoche  boolean GENERATED ALWAYS AS (primer_ticket_en::date <> ultimo_ticket_en::date) STORED,
    UNIQUE (estacion_key, numero)
);

CREATE TABLE IF NOT EXISTS dw.dim_bomba (
    bomba_key     int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    estacion_key  int NOT NULL REFERENCES dw.dim_estacion,
    numero        int NOT NULL,
    descripcion   text,
    UNIQUE (estacion_key, numero)
);

CREATE TABLE IF NOT EXISTS dw.dim_producto (
    producto_key   int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    nombre_origen  text NOT NULL UNIQUE,    -- como lo escribe el reporte
    nombre         text NOT NULL,
    familia        text NOT NULL,           -- COMBUSTIBLE, LUBRICANTE, TIENDA, N/D
    tipo           text,                    -- DIESEL, GASOLINA
    unidad         text                     -- GALON
);

-- Cliente: el reporte siempre muestra el nombre y NIT actuales del maestro, no los de la fecha del ticket.
-- Tipo 2 en el NIT (abre versión nueva desde la carga que trae el cambio) y tipo 1 en el nombre.
CREATE TABLE IF NOT EXISTS dw.dim_cliente (
    cliente_key          int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    codigo               text NOT NULL,     -- CardCode; CF = consumidor final
    nit                  text,
    nombre               text NOT NULL,     -- sin espacios de más
    es_consumidor_final  boolean NOT NULL,
    nit_valido           boolean,           -- dígito verificador del NIT de Guatemala
    vigente_desde        timestamptz NOT NULL DEFAULT '1900-01-01',
    vigente_hasta        timestamptz NOT NULL DEFAULT '9999-12-31',
    es_actual            boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cliente_actual ON dw.dim_cliente (codigo) WHERE es_actual;
CREATE INDEX IF NOT EXISTS ix_cliente_nit ON dw.dim_cliente (nit);

CREATE TABLE IF NOT EXISTS dw.dim_pricebook (
    pricebook_key     int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    nombre_origen     text NOT NULL UNIQUE, -- 'Precio de Lista', 'descuento 2.00', 'Recargo Q1.00'
    tipo              text NOT NULL,        -- LISTA, DESCUENTO, RECARGO, OTRO
    ajuste_por_galon  numeric(10,2) NOT NULL DEFAULT 0
);

-- Dimensión "junk": banderas de poca cardinalidad del ticket
CREATE TABLE IF NOT EXISTS dw.dim_tipo_venta (
    tipo_venta_key  int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    servicio        text    NOT NULL,
    credito         text    NOT NULL,       -- hoy siempre vacío en el reporte: N/D
    plan_fidelidad  text    NOT NULL,
    con_vale        boolean NOT NULL,
    con_factura     boolean NOT NULL,
    UNIQUE (servicio, credito, plan_fidelidad, con_vale, con_factura)
);

-- Miembros "no definido"
INSERT INTO dw.dim_fecha (fecha_key, nombre_mes, nombre_dia) VALUES (-1, 'N/D', 'N/D')
ON CONFLICT DO NOTHING;
INSERT INTO dw.dim_hora (hora_key, hora_texto, rango_hora, franja) VALUES (-1, 'N/D', 'N/D', 'N/D')
ON CONFLICT DO NOTHING;
INSERT INTO dw.dim_estacion (estacion_key, codigo, nombre) VALUES (-1, 'N/D', 'No definida')
ON CONFLICT DO NOTHING;
INSERT INTO dw.dim_turno (turno_key, estacion_key, numero) VALUES (-1, -1, -1)
ON CONFLICT DO NOTHING;
INSERT INTO dw.dim_bomba (bomba_key, estacion_key, numero, descripcion) VALUES (-1, -1, -1, 'No definida')
ON CONFLICT DO NOTHING;
INSERT INTO dw.dim_producto (producto_key, nombre_origen, nombre, familia) VALUES (-1, '(vacío)', 'SIN PRODUCTO', 'N/D')
ON CONFLICT DO NOTHING;
INSERT INTO dw.dim_cliente (cliente_key, codigo, nombre, es_consumidor_final) VALUES (-1, 'N/D', 'No definido', false)
ON CONFLICT DO NOTHING;
INSERT INTO dw.dim_pricebook (pricebook_key, nombre_origen, tipo) VALUES (-1, '(vacío)', 'N/D')
ON CONFLICT DO NOTHING;
INSERT INTO dw.dim_tipo_venta (tipo_venta_key, servicio, credito, plan_fidelidad, con_vale, con_factura)
VALUES (-1, 'N/D', 'N/D', 'N/D', false, false)
ON CONFLICT DO NOTHING;

-- Calendario. La carga lo extiende sola si llega un ticket fuera del rango instalado
CREATE OR REPLACE FUNCTION dw.llenar_calendario(p_desde date, p_hasta date)
RETURNS void LANGUAGE sql AS $$
    INSERT INTO dw.dim_fecha (fecha_key, fecha, anio, trimestre, mes, nombre_mes, anio_mes, semana_iso, dia,
                              dia_semana, nombre_dia, es_fin_de_semana, es_feriado, nombre_feriado)
    SELECT to_char(d, 'YYYYMMDD')::int,
           d::date,
           extract(year FROM d),
           extract(quarter FROM d),
           extract(month FROM d),
           (ARRAY['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre',
                  'Octubre','Noviembre','Diciembre'])[extract(month FROM d)::int],
           to_char(d, 'YYYY-MM'),
           extract(week FROM d),
           extract(day FROM d),
           extract(isodow FROM d),
           (ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'])[extract(isodow FROM d)::int],
           extract(isodow FROM d) IN (6, 7),
           f.nombre IS NOT NULL,
           f.nombre
    FROM generate_series(p_desde, p_hasta, interval '1 day') AS g(d)
    -- Feriados nacionales de fecha fija; Semana Santa y feriados locales se marcan aparte
    LEFT JOIN (VALUES ('01-01', 'Año Nuevo'), ('05-01', 'Día del Trabajo'), ('09-15', 'Día de la Independencia'),
                      ('10-20', 'Día de la Revolución'), ('11-01', 'Día de Todos los Santos'), ('12-25', 'Navidad'))
              AS f(mes_dia, nombre) ON f.mes_dia = to_char(d, 'MM-DD')
    ON CONFLICT (fecha_key) DO NOTHING;
$$;

SELECT dw.llenar_calendario('2020-01-01', '2035-12-31');

INSERT INTO dw.dim_hora (hora_key, hora, minuto, hora_texto, rango_hora, franja)
SELECT m, m / 60, m % 60,
       lpad((m / 60)::text, 2, '0') || ':' || lpad((m % 60)::text, 2, '0'),
       lpad((m / 60)::text, 2, '0') || ':00-' || lpad((m / 60)::text, 2, '0') || ':59',
       CASE WHEN m / 60 < 5 THEN 'Madrugada (00-04)'
            WHEN m / 60 < 12 THEN 'Mañana (05-11)'
            WHEN m / 60 < 18 THEN 'Tarde (12-17)'
            ELSE 'Noche (18-23)' END
FROM generate_series(0, 1439) AS m
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- dw: hecho de despachos. Grano: un ticket (un despacho, de un producto, en una bomba)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dw.fact_despacho (
    fecha_key             int      NOT NULL REFERENCES dw.dim_fecha,
    hora_key              smallint NOT NULL REFERENCES dw.dim_hora,
    estacion_key          int      NOT NULL REFERENCES dw.dim_estacion,
    turno_key             int      NOT NULL REFERENCES dw.dim_turno,
    bomba_key             int      NOT NULL REFERENCES dw.dim_bomba,
    producto_key          int      NOT NULL REFERENCES dw.dim_producto,
    cliente_key           int      NOT NULL REFERENCES dw.dim_cliente,
    pricebook_key         int      NOT NULL REFERENCES dw.dim_pricebook,
    tipo_venta_key        int      NOT NULL REFERENCES dw.dim_tipo_venta,
    -- dimensiones degeneradas
    ticket_numero         bigint   NOT NULL,
    factura_serie         text,
    factura_numero        text,
    vale_numero           text,
    fecha_hora            timestamp NOT NULL,
    -- medidas aditivas (se pueden sumar en cualquier dimensión)
    cantidad_gal          numeric(14,5) NOT NULL,
    monto_total           numeric(14,2) NOT NULL,   -- lo cobrado
    iva                   numeric(18,6),
    idp                   numeric(18,6),
    monto_neto            numeric(18,6),            -- total - IVA - IDP; nulo si el reporte lo deja vacío
    descuento_redondeo    numeric(18,9),            -- columna Descto.: cantidad x precio - total
    descuento_pricebook   numeric(18,6) NOT NULL,   -- (precio lista - precio despacho) x cantidad
    valor_precio_lista    numeric(18,6),            -- precio lista x cantidad
    costo_total           numeric(20,9) NOT NULL,
    utilidad              numeric(20,9),            -- monto neto - costo
    -- valores unitarios del ticket: NO se suman, se promedian ponderando por galones (ver mart)
    precio_despacho       numeric(12,4),
    precio_lista          numeric(12,4),
    costo_unitario        numeric(12,4),
    -- linaje
    carga_id_alta         bigint NOT NULL REFERENCES etl.carga,  -- carga que lo trajo por primera vez
    carga_id_ultima       bigint NOT NULL REFERENCES etl.carga,  -- última carga que lo trajo
    carga_id_cambio       bigint NOT NULL REFERENCES etl.carga,  -- última carga que le cambió algo
    hash_fila             text   NOT NULL,          -- huella de los valores base, para detectar cambios
    PRIMARY KEY (estacion_key, ticket_numero, fecha_key)
) PARTITION BY RANGE (fecha_key);

CREATE INDEX IF NOT EXISTS ix_despacho_producto_fecha ON dw.fact_despacho (producto_key, fecha_key);
CREATE INDEX IF NOT EXISTS ix_despacho_cliente ON dw.fact_despacho (cliente_key);
CREATE INDEX IF NOT EXISTS ix_despacho_turno ON dw.fact_despacho (turno_key);
CREATE INDEX IF NOT EXISTS ix_despacho_factura ON dw.fact_despacho (factura_serie, factura_numero) WHERE factura_numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS brin_despacho_fecha_hora ON dw.fact_despacho USING brin (fecha_hora);

-- Una partición por año; la carga la crea sola antes de insertar si no existe
CREATE OR REPLACE FUNCTION dw.asegurar_particion_despacho(p_anio int)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('CREATE TABLE IF NOT EXISTS dw.fact_despacho_%s PARTITION OF dw.fact_despacho
                    FOR VALUES FROM (%s) TO (%s)', p_anio, p_anio * 10000 + 101, (p_anio + 1) * 10000 + 101);
END $$;

SELECT dw.asegurar_particion_despacho(extract(year FROM current_date)::int);

-- Dígito verificador del NIT de Guatemala (módulo 11; K = 10)
CREATE OR REPLACE FUNCTION dw.nit_es_valido(p_nit text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v text := upper(replace(coalesce(p_nit, ''), '-', ''));
    cuerpo text;
    suma int := 0;
    r int;
BEGIN
    IF v IN ('', 'CF') OR v !~ '^[0-9]+[0-9K]$' THEN
        RETURN NULL;
    END IF;
    cuerpo := left(v, -1);
    FOR i IN 1 .. length(cuerpo) LOOP
        suma := suma + substr(cuerpo, i, 1)::int * (length(cuerpo) + 2 - i);
    END LOOP;
    r := (11 - suma % 11) % 11;
    RETURN right(v, 1) = CASE WHEN r = 10 THEN 'K' ELSE r::text END;
END $$;

-- =====================================================================
-- Paso de staging a la estrella para una carga del reporte "Consulta de Tickets".
-- El ETL lee el Excel, valida, cuadra contra los totales del reporte, copia los tickets
-- a stg.ticket_despacho (COPY) y luego llama, en la misma transacción:
--     SELECT * FROM dw.cargar_tickets(carga_id);
-- Es idempotente: cargar otra vez el mismo período (o uno que se traslapa) actualiza
-- solo los tickets que cambiaron y deja constancia en etl.cambio.
-- =====================================================================
CREATE OR REPLACE FUNCTION dw.cargar_tickets(p_carga_id bigint)
RETURNS TABLE (insertadas int, actualizadas int, sin_cambio int, movidas int, no_vinieron int)
LANGUAGE plpgsql AS $$
DECLARE
    v_ins   int := 0;
    v_upd   int := 0;
    v_igual int := 0;
    v_mov   int := 0;
    v_falt  int := 0;
    v_ahora timestamptz := now();
    v_anio  int;
BEGIN
    -- Dos cargas a la vez se ponen en fila: la segunda espera a que termine la primera
    PERFORM pg_advisory_xact_lock(hashtext('dw.cargar_tickets'));

    -- 1) Normalizar lo que vino en staging -----------------------------------------
    DROP TABLE IF EXISTS t_stg;
    CREATE TEMP TABLE t_stg ON COMMIT DROP AS
    SELECT s.*,
           CASE WHEN strpos(s.estacion, ' - ') > 0 THEN trim(split_part(s.estacion, ' - ', 1))
                ELSE trim(s.estacion) END                                   AS est_codigo,
           CASE WHEN strpos(s.estacion, ' - ') > 0 THEN trim(substr(s.estacion, strpos(s.estacion, ' - ') + 3))
                ELSE trim(s.estacion) END                                   AS est_nombre,
           coalesce(upper(nullif(trim(s.cliente_codigo), '')), 'N/D')      AS cli_codigo,
           upper(nullif(regexp_replace(coalesce(s.cliente_nit, ''), '[\s-]', '', 'g'), '')) AS cli_nit,
           CASE WHEN upper(trim(s.cliente_codigo)) = 'CF' THEN 'CONSUMIDOR FINAL'
                ELSE regexp_replace(trim(coalesce(s.cliente_nombre, '')), '\s+', ' ', 'g') END AS cli_nombre,
           upper(nullif(trim(s.producto), ''))                              AS prod,
           nullif(trim(s.pricebook), '')                                    AS pb,
           coalesce(nullif(trim(s.servicio), ''), 'N/D')                    AS tv_servicio,
           coalesce(nullif(trim(s.credito), ''), 'N/D')                     AS tv_credito,
           coalesce(nullif(trim(s.plan_fidelidad), ''), 'N/D')              AS tv_plan,
           nullif(trim(s.vale), '') IS NOT NULL                             AS tv_vale,
           nullif(trim(s.factura_numero), '') IS NOT NULL                   AS tv_factura,
           to_char(s.fecha_hora, 'YYYYMMDD')::int                           AS fecha_key,
           (extract(hour FROM s.fecha_hora) * 60 + extract(minute FROM s.fecha_hora))::smallint AS hora_key,
           -- huella de los valores base (los derivados, como costo total o utilidad, salen de estos)
           md5(concat_ws('|', s.turno, s.bomba, trim(s.factura_serie), trim(s.factura_numero), s.fecha_hora,
                         upper(trim(s.cliente_codigo)), trim(s.vale), upper(trim(s.producto)),
                         round(s.cantidad, 5), round(s.precio_despacho, 4), round(s.precio_lista, 4),
                         round(coalesce(s.iva, 0), 4), round(coalesce(s.idp, 0), 4), round(s.total, 2),
                         round(s.costo_unitario, 4), trim(s.pricebook), trim(s.servicio), trim(s.credito),
                         trim(s.plan_fidelidad)))                           AS hash_fila
    FROM stg.ticket_despacho s
    WHERE s.carga_id = p_carga_id;

    IF NOT EXISTS (SELECT 1 FROM t_stg) THEN
        RAISE EXCEPTION 'La carga % no tiene tickets en staging', p_carga_id;
    END IF;
    IF EXISTS (SELECT 1 FROM t_stg GROUP BY est_codigo, ticket HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'La carga % trae tickets repetidos', p_carga_id;
    END IF;

    PERFORM dw.llenar_calendario(min(fecha_hora)::date, max(fecha_hora)::date) FROM t_stg;
    FOR v_anio IN SELECT DISTINCT fecha_key / 10000 FROM t_stg LOOP
        PERFORM dw.asegurar_particion_despacho(v_anio);
    END LOOP;

    -- 2) Dimensiones -----------------------------------------------------------------
    INSERT INTO dw.dim_estacion AS d (codigo, nombre)
    SELECT DISTINCT ON (est_codigo) est_codigo, est_nombre FROM t_stg ORDER BY est_codigo
    ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre
    WHERE d.nombre IS DISTINCT FROM EXCLUDED.nombre AND EXCLUDED.nombre <> EXCLUDED.codigo;

    -- Las fechas del turno se recalculan desde los hechos al final (paso 7)
    INSERT INTO dw.dim_turno (estacion_key, numero)
    SELECT DISTINCT e.estacion_key, s.turno
    FROM t_stg s JOIN dw.dim_estacion e ON e.codigo = s.est_codigo
    ON CONFLICT (estacion_key, numero) DO NOTHING;

    INSERT INTO dw.dim_bomba (estacion_key, numero, descripcion)
    SELECT DISTINCT e.estacion_key, s.bomba, 'Bomba ' || s.bomba
    FROM t_stg s JOIN dw.dim_estacion e ON e.codigo = s.est_codigo
    WHERE s.bomba IS NOT NULL
    ON CONFLICT (estacion_key, numero) DO NOTHING;

    -- La clasificación de productos pasará a una tabla de configuración cuando entren lubricantes y tienda
    INSERT INTO dw.dim_producto (nombre_origen, nombre, familia, tipo, unidad)
    SELECT DISTINCT prod, prod,
           CASE WHEN prod IN ('DIESEL', 'REGULAR', 'SUPER') THEN 'COMBUSTIBLE' ELSE 'N/D' END,
           CASE prod WHEN 'DIESEL' THEN 'DIESEL' WHEN 'REGULAR' THEN 'GASOLINA' WHEN 'SUPER' THEN 'GASOLINA' END,
           CASE WHEN prod IN ('DIESEL', 'REGULAR', 'SUPER') THEN 'GALON' END
    FROM t_stg WHERE prod IS NOT NULL
    ON CONFLICT (nombre_origen) DO NOTHING;

    INSERT INTO dw.dim_pricebook (nombre_origen, tipo, ajuste_por_galon)
    SELECT DISTINCT pb,
           CASE WHEN pb ILIKE 'precio de lista%' THEN 'LISTA'
                WHEN pb ILIKE 'descuento%' THEN 'DESCUENTO'
                WHEN pb ILIKE 'recargo%' THEN 'RECARGO'
                ELSE 'OTRO' END,
           CASE WHEN pb ILIKE 'descuento%' THEN -1 WHEN pb ILIKE 'recargo%' THEN 1 ELSE 0 END
           * coalesce(substring(pb FROM '([0-9]+(\.[0-9]+)?)')::numeric, 0)
    FROM t_stg WHERE pb IS NOT NULL
    ON CONFLICT (nombre_origen) DO NOTHING;

    INSERT INTO dw.dim_tipo_venta (servicio, credito, plan_fidelidad, con_vale, con_factura)
    SELECT DISTINCT tv_servicio, tv_credito, tv_plan, tv_vale, tv_factura FROM t_stg
    ON CONFLICT (servicio, credito, plan_fidelidad, con_vale, con_factura) DO NOTHING;

    -- Cliente: un valor por código (si un código trae dos escrituras en el mismo archivo, gana la más frecuente)
    DROP TABLE IF EXISTS t_cli;
    CREATE TEMP TABLE t_cli ON COMMIT DROP AS
    SELECT cli_codigo AS codigo,
           mode() WITHIN GROUP (ORDER BY cli_nit)    AS nit,
           mode() WITHIN GROUP (ORDER BY cli_nombre) AS nombre
    FROM t_stg WHERE cli_codigo <> 'N/D'
    GROUP BY cli_codigo;

    -- Tipo 1: corrección de nombre en la versión vigente
    INSERT INTO etl.cambio (carga_id, entidad, llave, campo, valor_anterior, valor_nuevo)
    SELECT p_carga_id, 'CLIENTE', d.codigo, 'nombre', d.nombre, c.nombre
    FROM t_cli c JOIN dw.dim_cliente d ON d.codigo = c.codigo AND d.es_actual
    WHERE d.nombre IS DISTINCT FROM c.nombre AND d.nit IS NOT DISTINCT FROM c.nit;

    UPDATE dw.dim_cliente d SET nombre = c.nombre
    FROM t_cli c
    WHERE d.codigo = c.codigo AND d.es_actual
      AND d.nombre IS DISTINCT FROM c.nombre AND d.nit IS NOT DISTINCT FROM c.nit;

    -- Tipo 2: cambio de NIT, se cierra la versión vigente y se abre otra desde esta carga
    INSERT INTO etl.cambio (carga_id, entidad, llave, campo, valor_anterior, valor_nuevo)
    SELECT p_carga_id, 'CLIENTE', d.codigo, 'nit', d.nit, c.nit
    FROM t_cli c JOIN dw.dim_cliente d ON d.codigo = c.codigo AND d.es_actual
    WHERE d.nit IS DISTINCT FROM c.nit;

    UPDATE dw.dim_cliente d SET vigente_hasta = v_ahora, es_actual = false
    FROM t_cli c
    WHERE d.codigo = c.codigo AND d.es_actual AND d.nit IS DISTINCT FROM c.nit;

    INSERT INTO dw.dim_cliente (codigo, nit, nombre, es_consumidor_final, nit_valido, vigente_desde)
    SELECT c.codigo, c.nit, c.nombre, c.codigo = 'CF', dw.nit_es_valido(c.nit),
           CASE WHEN EXISTS (SELECT 1 FROM dw.dim_cliente x WHERE x.codigo = c.codigo)
                THEN v_ahora ELSE '1900-01-01'::timestamptz END
    FROM t_cli c
    WHERE NOT EXISTS (SELECT 1 FROM dw.dim_cliente d WHERE d.codigo = c.codigo AND d.es_actual);

    -- 3) Hechos: resolver llaves --------------------------------------------------------
    DROP TABLE IF EXISTS t_hecho;
    CREATE TEMP TABLE t_hecho ON COMMIT DROP AS
    SELECT s.fecha_key,
           s.hora_key,
           e.estacion_key,
           coalesce(tu.turno_key, -1)       AS turno_key,
           coalesce(b.bomba_key, -1)        AS bomba_key,
           coalesce(p.producto_key, -1)     AS producto_key,
           -- un ticket ya cargado conserva la versión de cliente con la que entró
           CASE WHEN c0.codigo = s.cli_codigo THEN f0.cliente_key
                ELSE coalesce(ca.cliente_key, -1) END AS cliente_key,
           coalesce(pb.pricebook_key, -1)   AS pricebook_key,
           coalesce(tv.tipo_venta_key, -1)  AS tipo_venta_key,
           s.ticket                         AS ticket_numero,
           nullif(trim(s.factura_serie), '')  AS factura_serie,
           nullif(trim(s.factura_numero), '') AS factura_numero,
           nullif(trim(s.vale), '')         AS vale_numero,
           s.fecha_hora,
           s.cantidad                       AS cantidad_gal,
           s.total                          AS monto_total,
           s.iva,
           s.idp,
           s.total_neto                     AS monto_neto,
           s.descuento                      AS descuento_redondeo,
           CASE WHEN s.precio_lista > 0 THEN round((s.precio_lista - s.precio_despacho) * s.cantidad, 6)
                ELSE 0 END                  AS descuento_pricebook,
           CASE WHEN s.precio_lista > 0 THEN round(s.precio_lista * s.cantidad, 6) END AS valor_precio_lista,
           s.costo_total,
           s.utilidad,
           s.precio_despacho,
           s.precio_lista,
           s.costo_unitario,
           s.hash_fila,
           s.cli_codigo,
           f0.fecha_key                     AS fecha_key_anterior,
           f0.hash_fila                     AS hash_anterior
    FROM t_stg s
    JOIN dw.dim_estacion e        ON e.codigo = s.est_codigo
    LEFT JOIN dw.dim_turno tu     ON tu.estacion_key = e.estacion_key AND tu.numero = s.turno
    LEFT JOIN dw.dim_bomba b      ON b.estacion_key = e.estacion_key AND b.numero = s.bomba
    LEFT JOIN dw.dim_producto p   ON p.nombre_origen = s.prod
    LEFT JOIN dw.dim_pricebook pb ON pb.nombre_origen = s.pb
    LEFT JOIN dw.dim_tipo_venta tv
           ON (tv.servicio, tv.credito, tv.plan_fidelidad, tv.con_vale, tv.con_factura)
            = (s.tv_servicio, s.tv_credito, s.tv_plan, s.tv_vale, s.tv_factura)
    LEFT JOIN dw.dim_cliente ca   ON ca.codigo = s.cli_codigo AND ca.es_actual
    LEFT JOIN dw.fact_despacho f0 ON f0.estacion_key = e.estacion_key AND f0.ticket_numero = s.ticket
    LEFT JOIN dw.dim_cliente c0   ON c0.cliente_key = f0.cliente_key;

    SELECT count(*) FILTER (WHERE hash_anterior IS NULL),
           count(*) FILTER (WHERE hash_anterior IS NOT NULL AND hash_anterior <> hash_fila),
           count(*) FILTER (WHERE hash_anterior = hash_fila),
           count(*) FILTER (WHERE fecha_key_anterior <> fecha_key)
    INTO v_ins, v_upd, v_igual, v_mov
    FROM t_hecho;

    -- 4) Bitácora de lo que cambió en tickets ya cargados ------------------------------
    INSERT INTO etl.cambio (carga_id, entidad, llave, campo, valor_anterior, valor_nuevo)
    SELECT p_carga_id, 'TICKET', e.codigo || '-' || h.ticket_numero, x.campo, x.antes, x.despues
    FROM t_hecho h
    JOIN dw.fact_despacho f   ON f.estacion_key = h.estacion_key AND f.ticket_numero = h.ticket_numero
    JOIN dw.dim_estacion e    ON e.estacion_key = h.estacion_key
    JOIN dw.dim_turno t1      ON t1.turno_key = f.turno_key
    JOIN dw.dim_turno t2      ON t2.turno_key = h.turno_key
    JOIN dw.dim_bomba b1      ON b1.bomba_key = f.bomba_key
    JOIN dw.dim_bomba b2      ON b2.bomba_key = h.bomba_key
    JOIN dw.dim_cliente c1    ON c1.cliente_key = f.cliente_key
    JOIN dw.dim_producto p1   ON p1.producto_key = f.producto_key
    JOIN dw.dim_producto p2   ON p2.producto_key = h.producto_key
    JOIN dw.dim_pricebook pb1 ON pb1.pricebook_key = f.pricebook_key
    JOIN dw.dim_pricebook pb2 ON pb2.pricebook_key = h.pricebook_key
    JOIN dw.dim_tipo_venta v1 ON v1.tipo_venta_key = f.tipo_venta_key
    JOIN dw.dim_tipo_venta v2 ON v2.tipo_venta_key = h.tipo_venta_key
    CROSS JOIN LATERAL (VALUES
        ('turno',           t1.numero::text,              t2.numero::text),
        ('bomba',           b1.numero::text,              b2.numero::text),
        ('fecha_hora',      f.fecha_hora::text,           h.fecha_hora::text),
        ('factura',         concat_ws('-', f.factura_serie, f.factura_numero), concat_ws('-', h.factura_serie, h.factura_numero)),
        ('cliente',         c1.codigo,                    h.cli_codigo),
        ('producto',        p1.nombre_origen,             p2.nombre_origen),
        ('vale',            f.vale_numero,                h.vale_numero),
        ('cantidad',        f.cantidad_gal::text,         h.cantidad_gal::text),
        ('precio_despacho', f.precio_despacho::text,      h.precio_despacho::text),
        ('precio_lista',    f.precio_lista::text,         h.precio_lista::text),
        ('total',           f.monto_total::text,          h.monto_total::text),
        ('iva',             round(f.iva, 4)::text,        round(h.iva, 4)::text),
        ('idp',             round(f.idp, 4)::text,        round(h.idp, 4)::text),
        ('costo_unitario',  f.costo_unitario::text,       h.costo_unitario::text),
        ('pricebook',       pb1.nombre_origen,            pb2.nombre_origen),
        ('servicio',        v1.servicio,                  v2.servicio),
        ('credito',         v1.credito,                   v2.credito),
        ('plan_fidelidad',  v1.plan_fidelidad,            v2.plan_fidelidad)
    ) AS x(campo, antes, despues)
    WHERE f.hash_fila <> h.hash_fila
      AND x.antes IS DISTINCT FROM x.despues;

    -- Una factura que desaparece suele ser un archivo más viejo cargado después de uno más nuevo,
    -- o una factura anulada en BISS: entra igual (el último archivo manda), pero se avisa
    INSERT INTO etl.incidencia (carga_id, ticket_numero, severidad, regla, columna, valor, mensaje)
    SELECT p_carga_id, h.ticket_numero, 'ADVERTENCIA', 'FACTURA_QUITADA', 'factura',
           concat_ws('-', f.factura_serie, f.factura_numero),
           'El ticket ' || h.ticket_numero || ' tenía la factura ' || concat_ws('-', f.factura_serie, f.factura_numero)
           || ' y en este archivo viene sin factura (¿archivo más viejo o factura anulada?)'
    FROM t_hecho h
    JOIN dw.fact_despacho f ON f.estacion_key = h.estacion_key AND f.ticket_numero = h.ticket_numero
    WHERE f.factura_numero IS NOT NULL AND h.factura_numero IS NULL;

    -- Un ticket cuya fecha cambió de día se mueve: se borra de su fecha anterior y entra con la nueva
    DELETE FROM dw.fact_despacho f
    USING t_hecho h
    WHERE f.estacion_key = h.estacion_key AND f.ticket_numero = h.ticket_numero
      AND f.fecha_key <> h.fecha_key;

    -- 5) Insertar nuevos y refrescar los existentes: el último archivo manda en los valores
    --    (por ejemplo, una exportación con más decimales), pero solo cuenta como cambio
    --    lo que movió la huella de valores base
    INSERT INTO dw.fact_despacho AS f (
        fecha_key, hora_key, estacion_key, turno_key, bomba_key, producto_key, cliente_key, pricebook_key,
        tipo_venta_key, ticket_numero, factura_serie, factura_numero, vale_numero, fecha_hora,
        cantidad_gal, monto_total, iva, idp, monto_neto, descuento_redondeo, descuento_pricebook,
        valor_precio_lista, costo_total, utilidad, precio_despacho, precio_lista, costo_unitario,
        carga_id_alta, carga_id_ultima, carga_id_cambio, hash_fila)
    SELECT fecha_key, hora_key, estacion_key, turno_key, bomba_key, producto_key, cliente_key, pricebook_key,
           tipo_venta_key, ticket_numero, factura_serie, factura_numero, vale_numero, fecha_hora,
           cantidad_gal, monto_total, iva, idp, monto_neto, descuento_redondeo, descuento_pricebook,
           valor_precio_lista, costo_total, utilidad, precio_despacho, precio_lista, costo_unitario,
           p_carga_id, p_carga_id, p_carga_id, hash_fila
    FROM t_hecho
    ON CONFLICT (estacion_key, ticket_numero, fecha_key) DO UPDATE
    SET hora_key = EXCLUDED.hora_key,
        turno_key = EXCLUDED.turno_key,
        bomba_key = EXCLUDED.bomba_key,
        producto_key = EXCLUDED.producto_key,
        cliente_key = EXCLUDED.cliente_key,
        pricebook_key = EXCLUDED.pricebook_key,
        tipo_venta_key = EXCLUDED.tipo_venta_key,
        factura_serie = EXCLUDED.factura_serie,
        factura_numero = EXCLUDED.factura_numero,
        vale_numero = EXCLUDED.vale_numero,
        fecha_hora = EXCLUDED.fecha_hora,
        cantidad_gal = EXCLUDED.cantidad_gal,
        monto_total = EXCLUDED.monto_total,
        iva = EXCLUDED.iva,
        idp = EXCLUDED.idp,
        monto_neto = EXCLUDED.monto_neto,
        descuento_redondeo = EXCLUDED.descuento_redondeo,
        descuento_pricebook = EXCLUDED.descuento_pricebook,
        valor_precio_lista = EXCLUDED.valor_precio_lista,
        costo_total = EXCLUDED.costo_total,
        utilidad = EXCLUDED.utilidad,
        precio_despacho = EXCLUDED.precio_despacho,
        precio_lista = EXCLUDED.precio_lista,
        costo_unitario = EXCLUDED.costo_unitario,
        carga_id_ultima = EXCLUDED.carga_id_ultima,
        carga_id_cambio = CASE WHEN f.hash_fila <> EXCLUDED.hash_fila THEN EXCLUDED.carga_id_cambio
                               ELSE f.carga_id_cambio END,
        hash_fila = EXCLUDED.hash_fila;

    -- 6) Tickets que ya estaban cargados y no vinieron, dentro del rango de tickets que el archivo
    --    sí trae para ese turno (puede ser un ticket borrado en el sistema origen)
    INSERT INTO etl.incidencia (carga_id, ticket_numero, severidad, regla, mensaje)
    SELECT p_carga_id, f.ticket_numero, 'ADVERTENCIA', 'TICKET_NO_VINO',
           'El ticket ' || f.ticket_numero || ' estaba cargado y no viene en este archivo, aunque su turno sí viene'
    FROM (SELECT estacion_key, turno_key, min(ticket_numero) AS desde, max(ticket_numero) AS hasta
          FROM t_hecho GROUP BY estacion_key, turno_key) r
    JOIN dw.fact_despacho f
      ON f.estacion_key = r.estacion_key AND f.turno_key = r.turno_key
     AND f.ticket_numero BETWEEN r.desde AND r.hasta
    WHERE NOT EXISTS (SELECT 1 FROM t_hecho h
                      WHERE h.estacion_key = f.estacion_key AND h.ticket_numero = f.ticket_numero);
    GET DIAGNOSTICS v_falt = ROW_COUNT;

    -- 7) Apertura, cierre y fecha operativa de los turnos tocados. La fecha operativa es el día
    --    con más tickets: el turno 764 (30 sep 05:18 a 1 oct 06:51) queda en el 30 de septiembre
    --    y el 773 (8 oct 22:44 a 9 oct 21:52) en el 9 de octubre
    UPDATE dw.dim_turno t
    SET primer_ticket_en = x.primero, ultimo_ticket_en = x.ultimo, fecha_operativa = x.fecha
    FROM (SELECT f.turno_key, min(f.fecha_hora) AS primero, max(f.fecha_hora) AS ultimo,
                 mode() WITHIN GROUP (ORDER BY f.fecha_hora::date) AS fecha
          FROM dw.fact_despacho f
          WHERE f.turno_key IN (SELECT DISTINCT turno_key FROM t_hecho)
          GROUP BY f.turno_key) x
    WHERE t.turno_key = x.turno_key;

    -- 8) Cerrar la carga -----------------------------------------------------------------
    UPDATE etl.carga c
    SET estado = 'CARGADO',
        terminado_en = clock_timestamp(),
        estacion_codigo = x.est,
        turno_min = x.tmin, turno_max = x.tmax,
        fecha_min = x.fmin, fecha_max = x.fmax,
        filas_detalle = x.n,
        insertadas = v_ins, actualizadas = v_upd, sin_cambio = v_igual
    FROM (SELECT string_agg(DISTINCT est_codigo, ',') AS est, min(turno) AS tmin, max(turno) AS tmax,
                 min(fecha_hora) AS fmin, max(fecha_hora) AS fmax, count(*) AS n
          FROM t_stg) x
    WHERE c.carga_id = p_carga_id;

    RETURN QUERY SELECT v_ins, v_upd, v_igual, v_mov, v_falt;
END $$;

-- =====================================================================
-- mart: lo que consultan los tableros y la herramienta de BI.
-- Las medidas no aditivas (precio promedio, costo por galón, margen %) se calculan
-- siempre como cociente de sumas, nunca como promedio de los valores por ticket.
-- =====================================================================

-- Vista ancha: un renglón por ticket con todos sus atributos (fuente para Power BI, Superset o Metabase)
CREATE OR REPLACE VIEW mart.v_despacho AS
SELECT f.ticket_numero,
       f.fecha_hora,
       d.fecha, d.anio, d.trimestre, d.mes, d.nombre_mes, d.anio_mes, d.semana_iso, d.dia_semana, d.nombre_dia,
       d.es_fin_de_semana, d.es_feriado, d.nombre_feriado,
       h.hora, h.rango_hora, h.franja,
       e.codigo  AS estacion,
       e.nombre  AS estacion_nombre,
       t.numero  AS turno,
       t.fecha_operativa,
       b.numero  AS bomba,
       p.nombre  AS producto,
       p.familia AS familia_producto,
       p.tipo    AS tipo_producto,
       c.codigo  AS cliente_codigo,
       c.nit     AS cliente_nit,
       c.nombre  AS cliente,
       c.es_consumidor_final,
       c.nit_valido,
       pb.nombre_origen AS pricebook,
       pb.tipo          AS tipo_pricebook,
       tv.servicio, tv.credito, tv.plan_fidelidad, tv.con_vale, tv.con_factura,
       f.factura_serie, f.factura_numero, f.vale_numero,
       CASE WHEN f.factura_numero IS NULL THEN 'SIN FACTURA'
            WHEN fa.tickets > 1 THEN 'FACTURA GLOBAL'
            ELSE 'FACTURA INDIVIDUAL' END AS tipo_facturacion,
       f.cantidad_gal, f.monto_total, f.iva, f.idp, f.monto_neto, f.descuento_redondeo, f.descuento_pricebook,
       f.valor_precio_lista, f.costo_total, f.utilidad,
       f.precio_despacho, f.precio_lista, f.costo_unitario
FROM dw.fact_despacho f
JOIN dw.dim_fecha d       ON d.fecha_key = f.fecha_key
JOIN dw.dim_hora h        ON h.hora_key = f.hora_key
JOIN dw.dim_estacion e    ON e.estacion_key = f.estacion_key
JOIN dw.dim_turno t       ON t.turno_key = f.turno_key
JOIN dw.dim_bomba b       ON b.bomba_key = f.bomba_key
JOIN dw.dim_producto p    ON p.producto_key = f.producto_key
JOIN dw.dim_cliente c     ON c.cliente_key = f.cliente_key
JOIN dw.dim_pricebook pb  ON pb.pricebook_key = f.pricebook_key
JOIN dw.dim_tipo_venta tv ON tv.tipo_venta_key = f.tipo_venta_key
LEFT JOIN (SELECT estacion_key, factura_serie, factura_numero, count(*) AS tickets
           FROM dw.fact_despacho WHERE factura_numero IS NOT NULL
           GROUP BY estacion_key, factura_serie, factura_numero) fa
       ON fa.estacion_key = f.estacion_key AND fa.factura_serie = f.factura_serie
      AND fa.factura_numero = f.factura_numero;

-- Agregado diario: el cubo base de los tableros (fecha x estación x producto x tipo de cliente x factura x pricebook)
CREATE MATERIALIZED VIEW IF NOT EXISTS mart.mv_ventas_diarias AS
SELECT f.fecha_key,
       f.estacion_key,
       f.producto_key,
       c.es_consumidor_final,
       tv.con_factura,
       pb.tipo                       AS tipo_pricebook,
       count(*)                      AS tickets,
       sum(f.cantidad_gal)           AS galones,
       sum(f.monto_total)            AS monto_total,
       sum(f.iva)                    AS iva,
       sum(f.idp)                    AS idp,
       sum(f.monto_neto)             AS monto_neto,
       sum(f.costo_total)            AS costo_total,
       sum(f.utilidad)               AS utilidad,
       sum(f.descuento_pricebook)    AS descuento_pricebook,
       sum(f.descuento_redondeo)     AS descuento_redondeo,
       sum(f.valor_precio_lista)     AS valor_precio_lista
FROM dw.fact_despacho f
JOIN dw.dim_cliente c     ON c.cliente_key = f.cliente_key
JOIN dw.dim_tipo_venta tv ON tv.tipo_venta_key = f.tipo_venta_key
JOIN dw.dim_pricebook pb  ON pb.pricebook_key = f.pricebook_key
GROUP BY f.fecha_key, f.estacion_key, f.producto_key, c.es_consumidor_final, tv.con_factura, pb.tipo;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_ventas_diarias
    ON mart.mv_ventas_diarias (fecha_key, estacion_key, producto_key, es_consumidor_final, con_factura, tipo_pricebook);

-- Agregado por turno y producto
CREATE MATERIALIZED VIEW IF NOT EXISTS mart.mv_ventas_turno AS
SELECT f.estacion_key,
       f.turno_key,
       f.producto_key,
       count(*)              AS tickets,
       min(f.ticket_numero)  AS primer_ticket,
       max(f.ticket_numero)  AS ultimo_ticket,
       sum(f.cantidad_gal)   AS galones,
       sum(f.monto_total)    AS monto_total,
       sum(f.monto_neto)     AS monto_neto,
       sum(f.costo_total)    AS costo_total,
       sum(f.utilidad)       AS utilidad,
       sum(f.descuento_pricebook) AS descuento_pricebook,
       sum(f.monto_total) FILTER (WHERE f.factura_numero IS NULL) AS monto_sin_factura
FROM dw.fact_despacho f
GROUP BY f.estacion_key, f.turno_key, f.producto_key;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_ventas_turno ON mart.mv_ventas_turno (estacion_key, turno_key, producto_key);

-- Resumen mensual por producto, con las medidas no aditivas bien calculadas
CREATE OR REPLACE VIEW mart.v_resumen_mensual AS
SELECT d.anio_mes,
       e.codigo AS estacion,
       p.nombre AS producto,
       sum(v.tickets)      AS tickets,
       sum(v.galones)      AS galones,
       sum(v.monto_total)  AS monto_total,
       sum(v.monto_neto)   AS monto_neto,
       sum(v.costo_total)  AS costo_total,
       sum(v.utilidad)     AS utilidad,
       round(sum(v.monto_total) / nullif(sum(v.galones), 0), 4)          AS precio_promedio_gal,
       round(sum(v.costo_total) / nullif(sum(v.galones), 0), 4)          AS costo_promedio_gal,
       round(sum(v.utilidad) / nullif(sum(v.galones), 0), 4)             AS utilidad_por_galon,
       round(100 * sum(v.utilidad) / nullif(sum(v.monto_neto), 0), 2)    AS margen_pct,
       sum(v.descuento_pricebook) AS descuento_pricebook,
       round(100 * sum(v.monto_total) FILTER (WHERE NOT v.con_factura) / nullif(sum(v.monto_total), 0), 1) AS pct_monto_sin_factura
FROM mart.mv_ventas_diarias v
JOIN dw.dim_fecha d    ON d.fecha_key = v.fecha_key
JOIN dw.dim_estacion e ON e.estacion_key = v.estacion_key
JOIN dw.dim_producto p ON p.producto_key = v.producto_key
GROUP BY d.anio_mes, e.codigo, p.nombre;

-- Huecos en la numeración de tickets por estación
CREATE OR REPLACE VIEW mart.v_tickets_faltantes AS
SELECT e.codigo                     AS estacion,
       x.ticket_numero + 1          AS falta_desde,
       x.siguiente - 1              AS falta_hasta,
       x.siguiente - x.ticket_numero - 1 AS tickets_faltantes,
       x.fecha_hora                 AS ultimo_antes,
       x.fecha_siguiente            AS primero_despues,
       t.numero                     AS turno
FROM (SELECT f.estacion_key, f.ticket_numero, f.fecha_hora, f.turno_key,
             lead(f.ticket_numero) OVER w AS siguiente,
             lead(f.fecha_hora) OVER w    AS fecha_siguiente
      FROM dw.fact_despacho f
      WINDOW w AS (PARTITION BY f.estacion_key ORDER BY f.ticket_numero)) x
JOIN dw.dim_estacion e ON e.estacion_key = x.estacion_key
JOIN dw.dim_turno t    ON t.turno_key = x.turno_key
WHERE x.siguiente - x.ticket_numero > 1;

-- Tramos de precio de lista y de costo unitario por producto (cuándo cambió cada uno)
CREATE OR REPLACE VIEW mart.v_tramos_precio_costo AS
WITH base AS (
    SELECT f.estacion_key, f.producto_key, f.fecha_hora, f.ticket_numero, f.precio_lista, f.costo_unitario,
           CASE WHEN lag(f.precio_lista) OVER w IS DISTINCT FROM f.precio_lista THEN 1 ELSE 0 END AS cambia_lista,
           CASE WHEN lag(f.costo_unitario) OVER w IS DISTINCT FROM f.costo_unitario THEN 1 ELSE 0 END AS cambia_costo
    FROM dw.fact_despacho f
    WHERE f.producto_key <> -1
    WINDOW w AS (PARTITION BY f.estacion_key, f.producto_key ORDER BY f.fecha_hora, f.ticket_numero)
), grupos AS (
    SELECT *,
           sum(cambia_lista) OVER w AS tramo_lista,
           sum(cambia_costo) OVER w AS tramo_costo
    FROM base
    WINDOW w AS (PARTITION BY estacion_key, producto_key ORDER BY fecha_hora, ticket_numero)
)
SELECT e.codigo AS estacion, p.nombre AS producto, 'PRECIO LISTA' AS concepto, g.precio_lista AS valor,
       min(g.fecha_hora) AS desde, max(g.fecha_hora) AS hasta, count(*) AS tickets
FROM grupos g JOIN dw.dim_estacion e USING (estacion_key) JOIN dw.dim_producto p USING (producto_key)
GROUP BY e.codigo, p.nombre, g.tramo_lista, g.precio_lista
UNION ALL
SELECT e.codigo, p.nombre, 'COSTO UNITARIO', g.costo_unitario,
       min(g.fecha_hora), max(g.fecha_hora), count(*)
FROM grupos g JOIN dw.dim_estacion e USING (estacion_key) JOIN dw.dim_producto p USING (producto_key)
GROUP BY e.codigo, p.nombre, g.tramo_costo, g.costo_unitario;

-- Tickets que merecen revisión
CREATE OR REPLACE VIEW mart.v_alertas_ticket AS
WITH x AS (
    SELECT f.*,
           pb.ajuste_por_galon,
           lag(f.ticket_numero) OVER w AS ticket_anterior_bomba,
           lag(f.fecha_hora) OVER w    AS fecha_anterior_bomba,
           lag(f.cantidad_gal) OVER w  AS cantidad_anterior_bomba,
           lag(f.monto_total) OVER w   AS monto_anterior_bomba,
           lag(f.producto_key) OVER w  AS producto_anterior_bomba
    FROM dw.fact_despacho f
    JOIN dw.dim_pricebook pb ON pb.pricebook_key = f.pricebook_key
    WINDOW w AS (PARTITION BY f.estacion_key, f.bomba_key ORDER BY f.fecha_hora, f.ticket_numero)
)
SELECT e.codigo AS estacion, x.ticket_numero, x.fecha_hora, a.alerta, a.detalle, x.monto_total
FROM x
JOIN dw.dim_estacion e ON e.estacion_key = x.estacion_key
CROSS JOIN LATERAL (VALUES
    (CASE WHEN x.producto_key = -1 THEN 'SIN PRODUCTO' END,
     'El ticket no tiene producto ni precio de lista'),
    -- Montos prefijados (Q100 de Super son siempre 2.66099 gal) se repiten seguido en la misma bomba;
    -- solo es sospechoso si el ticket repetido cambia de producto
    (CASE WHEN x.ticket_anterior_bomba IS NOT NULL
               AND x.cantidad_gal = x.cantidad_anterior_bomba AND x.monto_total = x.monto_anterior_bomba
               AND x.producto_key <> x.producto_anterior_bomba
               AND x.fecha_hora - x.fecha_anterior_bomba <= interval '10 minutes' THEN 'POSIBLE DUPLICADO' END,
     'Misma bomba, galones y monto que el ticket ' || x.ticket_anterior_bomba || ', con otro producto'),
    (CASE WHEN x.utilidad < 0 THEN 'MARGEN NEGATIVO' END,
     'Costo ' || x.costo_unitario || ' mayor que el precio ' || x.precio_despacho),
    (CASE WHEN x.precio_lista > 0
               AND abs(x.precio_despacho - (x.precio_lista + x.ajuste_por_galon)) >= 0.005 THEN 'PRECIO FUERA DE PRICEBOOK' END,
     'Precio ' || x.precio_despacho || ' contra lista ' || x.precio_lista || ' y ajuste ' || x.ajuste_por_galon)
) AS a(alerta, detalle)
WHERE a.alerta IS NOT NULL;

-- Clientes a revisar: NIT que no pasa el dígito verificador o compartido por varios códigos
CREATE OR REPLACE VIEW mart.v_clientes_revision AS
SELECT c.codigo, c.nit, c.nombre, c.nit_valido,
       count(*) OVER (PARTITION BY c.nit) AS codigos_con_mismo_nit,
       coalesce(v.tickets, 0) AS tickets,
       coalesce(v.monto_total, 0) AS monto_total,
       coalesce(v.monto_sin_factura, 0) AS monto_sin_factura
FROM dw.dim_cliente c
LEFT JOIN (SELECT dc.codigo, count(*) AS tickets, sum(f.monto_total) AS monto_total,
                  sum(f.monto_total) FILTER (WHERE f.factura_numero IS NULL) AS monto_sin_factura
           FROM dw.fact_despacho f JOIN dw.dim_cliente dc ON dc.cliente_key = f.cliente_key
           GROUP BY dc.codigo) v ON v.codigo = c.codigo
WHERE c.es_actual AND NOT c.es_consumidor_final AND c.cliente_key <> -1;

-- Historial de cargas, para ver de un vistazo qué entró y qué se rechazó
CREATE OR REPLACE VIEW etl.v_cargas AS
SELECT c.carga_id, c.iniciado_en, c.archivo_nombre, c.usuario, c.estado,
       c.estacion_codigo, c.turno_min, c.turno_max, c.fecha_min, c.fecha_max,
       c.filas_detalle, c.insertadas, c.actualizadas, c.sin_cambio,
       (SELECT count(*) FROM etl.incidencia i WHERE i.carga_id = c.carga_id AND i.severidad = 'ERROR')       AS errores,
       (SELECT count(*) FROM etl.incidencia i WHERE i.carga_id = c.carga_id AND i.severidad = 'ADVERTENCIA') AS advertencias,
       (SELECT bool_and(q.cuadra) FROM etl.cuadre q WHERE q.carga_id = c.carga_id)                           AS cuadra,
       round(extract(epoch FROM c.terminado_en - c.iniciado_en)::numeric, 1)                                AS segundos,
       c.mensaje
FROM etl.carga c;

-- Se llama después de cada carga, ya confirmada la transacción
CREATE OR REPLACE PROCEDURE mart.refrescar()
LANGUAGE plpgsql AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mart.mv_ventas_diarias;
    REFRESH MATERIALIZED VIEW CONCURRENTLY mart.mv_ventas_turno;
END $$;

INSERT INTO etl.version_esquema (version, descripcion)
VALUES ('1.0.0', 'Consulta de Tickets: control de cargas, staging, estrella de despachos y capa mart')
ON CONFLICT DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------
-- Opcional: usuario de solo lectura para Power BI, Metabase u otra herramienta.
-- Copia estas líneas a una pestaña nueva del Query Tool, quita el "-- " del inicio,
-- pon tu contraseña y ejecútalas conectado a gas_station_db como gas_station_db.
-- Crear el usuario necesita un superusuario: en Dokploy gas_station_db lo es. En otro
-- servidor crea bi_lectura como postgres (paso 3 de sql/00_crear_base_de_datos.sql).
-- El usuario del ETL (gas_station_db) no necesita permisos extra: es el dueño de la base.
-- ---------------------------------------------------------------------
-- DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bi_lectura') THEN CREATE ROLE bi_lectura LOGIN PASSWORD 'cambia_esta_contraseña_bi'; END IF; END $$;
-- GRANT CONNECT ON DATABASE gas_station_db TO bi_lectura;
-- GRANT USAGE ON SCHEMA dw, mart, etl TO bi_lectura;
-- GRANT SELECT ON ALL TABLES IN SCHEMA dw, mart TO bi_lectura;
-- GRANT SELECT ON etl.v_cargas, etl.carga, etl.incidencia, etl.cuadre, etl.cambio TO bi_lectura;
-- ALTER DEFAULT PRIVILEGES FOR ROLE gas_station_db IN SCHEMA dw, mart GRANT SELECT ON TABLES TO bi_lectura;  -- así también se leen las particiones de años nuevos
