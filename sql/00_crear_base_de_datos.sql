-- =====================================================================
-- ETL_GAS_STATION: crear la base de datos A MANO (opcional)
--
-- En tu servidor Dokploy NO hace falta: Dokploy ya creó la base gas_station_db
-- y el usuario gas_station_db (Internal Credentials). Ahí solo se ejecuta
-- sql/instalar_base_de_datos.sql, o "npm run instalar-bd".
--
-- Este archivo sirve para montar la misma base en otro servidor PostgreSQL.
-- Ejecútalo conectado a la base "postgres" con un usuario administrador.
-- En pgAdmin ejecuta cada instrucción por separado (selecciónala y F5):
-- CREATE DATABASE no se puede ejecutar junto con otras instrucciones.
-- Con psql se ejecuta completo:
--   psql -h <servidor> -U postgres -d postgres -v ON_ERROR_STOP=1 -f sql/00_crear_base_de_datos.sql
-- Después instala las tablas con "npm run instalar-bd" o con sql/instalar_base_de_datos.sql
-- =====================================================================

-- 1) El usuario del ETL. Cambia la contraseña y ponla también en PGPASSWORD del .env.
--    Siendo dueño de la base, puede instalar las tablas y cargar sin más permisos.
--    Si el usuario ya existe, no se toca y se sigue con el paso 2.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gas_station_db') THEN
    CREATE ROLE gas_station_db LOGIN PASSWORD 'cambia_esta_contraseña';
  END IF;
END $$;

-- 2) La base del ETL, con ese usuario como dueño (mismo nombre que PGDATABASE del .env)
CREATE DATABASE gas_station_db WITH OWNER gas_station_db ENCODING 'UTF8' TEMPLATE template0;

-- 3) Opcional: un usuario de solo lectura para Power BI u otra herramienta.
--    Se crea aquí, como administrador (gas_station_db no puede crear usuarios en este servidor);
--    los permisos se dan al final de sql/instalar_base_de_datos.sql, conectado como gas_station_db.
-- CREATE ROLE bi_lectura LOGIN PASSWORD 'cambia_esta_contraseña_bi';
