-- =====================================================================
-- ETL_GAS_STATION 1.3.0: capacidad de los tanques y parámetros para recomendar pedidos
--
-- Se ejecuta DESPUÉS de sql/actualizar_tomas_fisicas.sql (1.2.0), conectado a gas_station_db:
--   * con el ETL:   npm run instalar-bd   (ejecuta los cuatro scripts, en orden)
--   * con pgAdmin:  Query Tool sobre gas_station_db, abrir este archivo y ejecutar (F5)
--   * con psql:     psql -h 72.62.80.172 -p 5432 -U gas_station_db -d gas_station_db -v ON_ERROR_STOP=1 -f sql/actualizar_tanques.sql
--
-- Se puede ejecutar las veces que haga falta: no borra datos ni duplica nada.
--
-- Qué agrega
--   dw.tanque   una fila por estación y combustible: capacidad total en galones (la suma de los tanques de ese
--               producto) y los parámetros con que el panel decide si hay que pedir. Se llena desde el panel
--               (Inventario > Nivel de los tanques > Configurar tanques)
-- =====================================================================

SET client_encoding = 'UTF8';

BEGIN;

DO $$
BEGIN
    IF to_regclass('dw.toma_fisica') IS NULL THEN
        RAISE EXCEPTION 'Primero ejecuta sql/actualizar_compras_inventario.sql y sql/actualizar_tomas_fisicas.sql';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS dw.tanque (
    estacion_key          int     NOT NULL REFERENCES dw.dim_estacion,
    producto_key          int     NOT NULL REFERENCES dw.dim_producto,
    capacidad_galones     numeric(12,2) NOT NULL CHECK (capacidad_galones > 0),
    -- Días desde que se hace el pedido hasta que el combustible está en el tanque
    tiempo_entrega_dias   numeric(5,2)  NOT NULL DEFAULT 1   CHECK (tiempo_entrega_dias >= 0),
    -- Días de venta que se quieren tener de reserva cuando llega la pipa
    dias_seguridad        numeric(5,2)  NOT NULL DEFAULT 1   CHECK (dias_seguridad >= 0),
    -- Por debajo de este porcentaje el pedido es urgente aunque se venda poco (fondo del tanque, bomba que no succiona)
    nivel_minimo_pct      numeric(5,2)  NOT NULL DEFAULT 15  CHECK (nivel_minimo_pct BETWEEN 0 AND 100),
    -- Hasta dónde se llena al descargar (se deja espacio por dilatación)
    llenado_maximo_pct    numeric(5,2)  NOT NULL DEFAULT 95  CHECK (llenado_maximo_pct BETWEEN 1 AND 100),
    -- Las compras vienen en múltiplos de este número de galones (PUMA: 500)
    multiplo_pedido       numeric(10,2) NOT NULL DEFAULT 500 CHECK (multiplo_pedido > 0),
    -- Días hacia adelante en que se proyecta el próximo pedido
    horizonte_dias        numeric(5,2)  NOT NULL DEFAULT 7   CHECK (horizonte_dias > 0),
    -- Días de venta con que se calcula el consumo promedio
    dias_consumo          int           NOT NULL DEFAULT 14  CHECK (dias_consumo BETWEEN 3 AND 90),
    actualizado_en        timestamptz   NOT NULL DEFAULT now(),
    actualizado_por       text,
    PRIMARY KEY (estacion_key, producto_key)
);

INSERT INTO etl.version_esquema (version, descripcion)
VALUES ('1.3.0', 'Capacidad de los tanques y parámetros para recomendar pedidos de combustible')
ON CONFLICT DO NOTHING;

COMMIT;

-- Opcional, si creaste el usuario de solo lectura bi_lectura:
-- GRANT SELECT ON dw.tanque TO bi_lectura;
