-- =====================================================================
-- ETL_GAS_STATION 1.2.0: mantenimiento de la toma física (crear, consultar, editar, anular y restaurar)
--
-- Se ejecuta DESPUÉS de sql/actualizar_compras_inventario.sql (1.1.0), conectado a gas_station_db:
--   * con el ETL:   npm run instalar-bd   (ejecuta los tres scripts, en orden)
--   * con pgAdmin:  Query Tool sobre gas_station_db, abrir este archivo y ejecutar (F5)
--   * con psql:     psql -h 72.62.80.172 -p 5432 -U gas_station_db -d gas_station_db -v ON_ERROR_STOP=1 -f sql/actualizar_tomas_fisicas.sql
--
-- Se puede ejecutar las veces que haga falta: no borra datos ni duplica nada.
--
-- Qué agrega
--   dw.toma_fisica.modificada_en / modificada_por   última edición de cada toma
--   dw.toma_fisica_historial                        bitácora: quién creó, cambió, anuló o restauró cada toma,
--                                                   con el valor anterior y el nuevo de cada campo
--   dw.registrar_cambio_toma()                      trigger que llena la bitácora sola (también si alguien
--                                                   edita la tabla desde pgAdmin)
-- =====================================================================

SET client_encoding = 'UTF8';

BEGIN;

DO $$
BEGIN
    IF to_regclass('dw.toma_fisica') IS NULL THEN
        RAISE EXCEPTION 'Primero ejecuta sql/actualizar_compras_inventario.sql: esta base no tiene la tabla dw.toma_fisica';
    END IF;
END $$;

ALTER TABLE dw.toma_fisica ADD COLUMN IF NOT EXISTS modificada_en  timestamptz;
ALTER TABLE dw.toma_fisica ADD COLUMN IF NOT EXISTS modificada_por text;

CREATE TABLE IF NOT EXISTS dw.toma_fisica_historial (
    historial_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    toma_id         bigint      NOT NULL REFERENCES dw.toma_fisica ON DELETE CASCADE,
    accion          text        NOT NULL CHECK (accion IN ('CREADA', 'MODIFICADA', 'ANULADA', 'RESTAURADA')),
    campo           text,                   -- en MODIFICADA: fecha_hora, galones u observaciones
    valor_anterior  text,
    valor_nuevo     text,
    usuario         text,
    en              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_toma_historial_toma ON dw.toma_fisica_historial (toma_id, historial_id);

-- Quién hizo el cambio: el panel lo pone en usuario (al crear), anulada_por (al anular) o modificada_por (al
-- editar o restaurar). Una edición hecha a mano sin decir quién queda con el usuario de PostgreSQL
CREATE OR REPLACE FUNCTION dw.registrar_cambio_toma()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO dw.toma_fisica_historial (toma_id, accion, valor_nuevo, usuario)
        VALUES (NEW.toma_id, 'CREADA', NEW.galones::text || ' gal a las ' || to_char(NEW.fecha_hora, 'DD/MM/YYYY HH24:MI'),
                coalesce(NEW.usuario, current_user));
        RETURN NEW;
    END IF;

    IF NOT OLD.anulada AND NEW.anulada THEN
        INSERT INTO dw.toma_fisica_historial (toma_id, accion, usuario)
        VALUES (NEW.toma_id, 'ANULADA', coalesce(NEW.anulada_por, current_user));
    ELSIF OLD.anulada AND NOT NEW.anulada THEN
        INSERT INTO dw.toma_fisica_historial (toma_id, accion, usuario)
        VALUES (NEW.toma_id, 'RESTAURADA', coalesce(NEW.modificada_por, current_user));
    END IF;

    INSERT INTO dw.toma_fisica_historial (toma_id, accion, campo, valor_anterior, valor_nuevo, usuario)
    SELECT NEW.toma_id, 'MODIFICADA', x.campo, x.antes, x.despues, coalesce(NEW.modificada_por, current_user)
    FROM (VALUES
        ('fecha_hora',    to_char(OLD.fecha_hora, 'DD/MM/YYYY HH24:MI'), to_char(NEW.fecha_hora, 'DD/MM/YYYY HH24:MI')),
        ('galones',       OLD.galones::text,                             NEW.galones::text),
        ('observaciones', OLD.observaciones,                             NEW.observaciones),
        ('producto',      OLD.producto_key::text,                        NEW.producto_key::text),
        ('estacion',      OLD.estacion_key::text,                        NEW.estacion_key::text)
    ) AS x(campo, antes, despues)
    WHERE x.antes IS DISTINCT FROM x.despues;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tr_toma_fisica_historial ON dw.toma_fisica;
CREATE TRIGGER tr_toma_fisica_historial
    AFTER INSERT OR UPDATE ON dw.toma_fisica
    FOR EACH ROW EXECUTE FUNCTION dw.registrar_cambio_toma();

-- Las tomas que ya existían quedan con su alta en la bitácora (una sola vez)
INSERT INTO dw.toma_fisica_historial (toma_id, accion, valor_nuevo, usuario, en)
SELECT t.toma_id, 'CREADA', t.galones::text || ' gal a las ' || to_char(t.fecha_hora, 'DD/MM/YYYY HH24:MI'),
       t.usuario, t.registrada_en
FROM dw.toma_fisica t
WHERE NOT EXISTS (SELECT 1 FROM dw.toma_fisica_historial h WHERE h.toma_id = t.toma_id);

INSERT INTO dw.toma_fisica_historial (toma_id, accion, usuario, en)
SELECT t.toma_id, 'ANULADA', t.anulada_por, t.anulada_en
FROM dw.toma_fisica t
WHERE t.anulada
  AND NOT EXISTS (SELECT 1 FROM dw.toma_fisica_historial h WHERE h.toma_id = t.toma_id AND h.accion = 'ANULADA');

INSERT INTO etl.version_esquema (version, descripcion)
VALUES ('1.2.0', 'Toma física: edición, restauración y bitácora de cambios')
ON CONFLICT DO NOTHING;

COMMIT;

-- Opcional, si creaste el usuario de solo lectura bi_lectura:
-- GRANT SELECT ON dw.toma_fisica_historial TO bi_lectura;
