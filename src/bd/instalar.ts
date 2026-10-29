// Instalación de la base de datos con los datos del .env: ejecuta sql/instalar_base_de_datos.sql y después
// sql/actualizar_compras_inventario.sql y sql/actualizar_tomas_fisicas.sql (todos se pueden repetir sin perder
// datos). La base solo se crea si se pide con --crear-base.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { CARPETA_PROYECTO, ErrorConfiguracion, leerConfig } from '../config.js';
import { explicarErrorConexion, ignorarEventoError, opcionesConexion } from '../db.js';

export const SCRIPT_INSTALACION = path.join(CARPETA_PROYECTO, 'sql', 'instalar_base_de_datos.sql');
/** Versión 1.1.0: compras, toma física e inventario. Va después de la instalación base */
export const SCRIPT_COMPRAS = path.join(CARPETA_PROYECTO, 'sql', 'actualizar_compras_inventario.sql');
/** Versión 1.2.0: edición de la toma física y su bitácora. Va después de la 1.1.0 */
export const SCRIPT_TOMAS = path.join(CARPETA_PROYECTO, 'sql', 'actualizar_tomas_fisicas.sql');
/** Versión 1.3.0: capacidad de los tanques y parámetros de pedido. Va después de la 1.2.0 */
export const SCRIPT_TANQUES = path.join(CARPETA_PROYECTO, 'sql', 'actualizar_tanques.sql');

const comillas = (identificador: string) => `"${identificador.replace(/"/g, '""')}"`;

async function revisarBase(log: (m: string) => void, crearBase: boolean): Promise<void> {
  const { bd } = leerConfig();
  const prueba = new pg.Client(opcionesConexion());
  ignorarEventoError(prueba);
  try {
    await prueba.connect();
    log(`La base de datos "${bd.database}" ya existe.`);
    return;
  } catch (err) {
    if ((err as { code?: string }).code !== '3D000') throw err;
  } finally {
    await prueba.end().catch(() => undefined);
  }

  // Sin --crear-base no se crea nada: un nombre mal escrito en PGDATABASE crearía una base vacía aparte
  if (!crearBase) {
    throw new ErrorConfiguracion(
      `La base de datos "${bd.database}" no existe en ${bd.host}. Revisa PGDATABASE en el .env (en Dokploy es gas_station_db).\n` +
        'Si es un servidor nuevo y quieres que el ETL la cree: npm run instalar-bd -- --crear-base',
    );
  }

  // Se crea desde la base de mantenimiento "postgres"
  const admin = new pg.Client(opcionesConexion('postgres'));
  ignorarEventoError(admin);
  try {
    await admin.connect();
  } catch (err) {
    await admin.end().catch(() => undefined);
    const codigo = (err as { code?: string }).code;
    const motivo =
      codigo === '3D000'
        ? 'ese servidor no tiene la base "postgres"'
        : codigo === '42501'
          ? `el usuario "${bd.user}" no tiene permiso para entrar a la base "postgres"`
          : explicarErrorConexion(err);
    throw new ErrorConfiguracion(
      `La base "${bd.database}" no existe y no pude entrar a la base "postgres" para crearla: ${motivo.replace(/\.?$/, '.')}\n` +
        'Pide a un administrador que la cree con sql/00_crear_base_de_datos.sql.',
    );
  }
  try {
    try {
      await admin.query(`CREATE DATABASE ${comillas(bd.database)} WITH ENCODING 'UTF8' TEMPLATE template0`);
    } catch (err) {
      // Si la configuración regional del servidor no admite UTF8 con template0, se usa la plantilla por defecto
      if ((err as { code?: string }).code !== '22023') throw err;
      await admin.query(`CREATE DATABASE ${comillas(bd.database)}`);
    }
    log(`Creé la base de datos "${bd.database}".`);
  } catch (err) {
    if ((err as { code?: string }).code === '42501') {
      throw new ErrorConfiguracion(
        `El usuario "${bd.user}" no tiene permiso para crear bases de datos, así que no pude crear "${bd.database}".\n` +
          'Revisa PGDATABASE en el .env o pide a un administrador que la cree con sql/00_crear_base_de_datos.sql.',
      );
    }
    throw err;
  } finally {
    await admin.end().catch(() => undefined);
  }
}

export interface OpcionesInstalacion {
  /** Crear la base si no existe (servidor nuevo). En Dokploy la base ya existe */
  crearBase?: boolean;
}

export async function instalarBaseDeDatos(
  log: (m: string) => void = console.log,
  opciones: OpcionesInstalacion = {},
): Promise<void> {
  await revisarBase(log, opciones.crearBase ?? false);
  const cliente = new pg.Client(opcionesConexion());
  ignorarEventoError(cliente);
  try {
    await cliente.connect();
    for (const script of [SCRIPT_INSTALACION, SCRIPT_COMPRAS, SCRIPT_TOMAS, SCRIPT_TANQUES]) await cliente.query(await readFile(script, 'utf8'));
    const v = await cliente.query<{ version: string }>(
      'SELECT version FROM etl.version_esquema ORDER BY instalado_en DESC, version DESC LIMIT 1',
    );
    log(`Esquema instalado (versión ${v.rows[0]?.version ?? '?'}): etl, stg, dw y mart, con compras, toma física (con su bitácora) e inventario.`);
  } finally {
    await cliente.end().catch(() => undefined);
  }
}

export interface EstadoConexion {
  servidor: string;
  baseDeDatos: string;
  usuario: string;
  esquemaInstalado: boolean;
  /** Ya se ejecutó sql/actualizar_compras_inventario.sql */
  comprasInstalado: boolean;
  versionEsquema: string | null;
  cargas: number | null;
  tickets: number | null;
}

export async function probarConexion(): Promise<EstadoConexion> {
  const cliente = new pg.Client(opcionesConexion());
  ignorarEventoError(cliente);
  try {
    await cliente.connect();
    const r = await cliente.query<{ servidor: string; base: string; usuario: string; instalado: boolean; compras: boolean }>(
      `SELECT current_setting('server_version') AS servidor, current_database() AS base, current_user AS usuario,
              to_regclass('etl.version_esquema') IS NOT NULL AS instalado,
              to_regclass('dw.fact_compra') IS NOT NULL AND to_regclass('dw.toma_fisica') IS NOT NULL AS compras`,
    );
    const fila = r.rows[0]!;
    const estado: EstadoConexion = {
      servidor: fila.servidor,
      baseDeDatos: fila.base,
      usuario: fila.usuario,
      esquemaInstalado: fila.instalado,
      comprasInstalado: fila.compras,
      versionEsquema: null,
      cargas: null,
      tickets: null,
    };
    if (fila.instalado) {
      const d = await cliente.query<{ version: string; cargas: number; tickets: number }>(
        `SELECT (SELECT version FROM etl.version_esquema ORDER BY instalado_en DESC, version DESC LIMIT 1) AS version,
                (SELECT count(*) FROM etl.carga WHERE estado = 'CARGADO') AS cargas,
                (SELECT count(*) FROM dw.fact_despacho) AS tickets`,
      );
      estado.versionEsquema = d.rows[0]!.version;
      estado.cargas = d.rows[0]!.cargas;
      estado.tickets = d.rows[0]!.tickets;
    }
    return estado;
  } finally {
    await cliente.end().catch(() => undefined);
  }
}
