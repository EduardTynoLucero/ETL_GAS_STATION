// Configuración del ETL: se lee del archivo .env de la carpeta del proyecto.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

export const CARPETA_PROYECTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// override: lo que diga el .env manda sobre variables PG* que ya existan en Windows
dotenv.config({ path: path.join(CARPETA_PROYECTO, '.env'), override: true, quiet: true });

const vacioComoIndefinido = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const texto = (porDefecto: string) => z.preprocess(vacioComoIndefinido, z.string().default(porDefecto));
const textoOpcional = () => z.preprocess(vacioComoIndefinido, z.string().optional());
const entero = (porDefecto: number, min: number, max: number) =>
  z.preprocess(vacioComoIndefinido, z.coerce.number().int().min(min).max(max).default(porDefecto));

// El texto que trae .env.example en PGPASSWORD; si sigue ahí, todavía no se puso la contraseña
export const CONTRASENA_DE_EJEMPLO = 'escribe_aqui_tu_contraseña';

const esquema = z.object({
  PGHOST: texto('72.62.80.172'),
  PGPORT: entero(5432, 1, 65535),
  PGDATABASE: texto('gas_station_db'),
  PGUSER: texto('gas_station_db'),
  PGPASSWORD: z.string().default(''),
  PGSSL: z.preprocess(vacioComoIndefinido, z.enum(['true', 'false']).default('false')),
  PGSSL_CA: textoOpcional(),
  ETL_ESTACION_POR_DEFECTO: textoOpcional(),
  ETL_USUARIO: textoOpcional(),
  ETL_CARPETA_ENTRADA: texto('entrada'),
  ETL_CARPETA_PROCESADOS: texto('procesados'),
  ETL_CARPETA_RECHAZADOS: texto('rechazados'),
  ETL_INTERVALO_VIGILAR_SEG: entero(30, 5, 86400),
  ETL_DIAS_STAGING: entero(30, 0, 3650),
});

export interface Config {
  bd: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: false | { ca?: string };
  };
  estacionPorDefecto?: string;
  usuario: string;
  carpetas: { entrada: string; procesados: string; rechazados: string };
  intervaloVigilarSeg: number;
  diasStaging: number;
}

export class ErrorConfiguracion extends Error {}

let cache: Config | undefined;

export const existeEnv = () => existsSync(path.join(CARPETA_PROYECTO, '.env'));

export function leerConfig(): Config {
  if (cache) return cache;
  if (!existeEnv()) {
    throw new ErrorConfiguracion(
      `No existe el archivo .env en ${CARPETA_PROYECTO}.\n` +
        'Créalo copiando la plantilla (copy .env.example .env) y pon ahí tus datos de PostgreSQL.',
    );
  }
  const r = esquema.safeParse(process.env);
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ErrorConfiguracion(`Revisa el archivo .env:\n${detalle}`);
  }
  const e = r.data;
  const carpeta = (p: string) => (path.isAbsolute(p) ? p : path.join(CARPETA_PROYECTO, p));
  let ssl: Config['bd']['ssl'] = false;
  if (e.PGSSL === 'true') {
    ssl = e.PGSSL_CA ? { ca: readFileSync(carpeta(e.PGSSL_CA), 'utf8') } : {};
  }
  cache = {
    bd: {
      host: e.PGHOST,
      port: e.PGPORT,
      database: e.PGDATABASE,
      user: e.PGUSER,
      password: e.PGPASSWORD,
      ssl,
    },
    estacionPorDefecto: e.ETL_ESTACION_POR_DEFECTO,
    usuario: e.ETL_USUARIO ?? os.userInfo().username,
    carpetas: {
      entrada: carpeta(e.ETL_CARPETA_ENTRADA),
      procesados: carpeta(e.ETL_CARPETA_PROCESADOS),
      rechazados: carpeta(e.ETL_CARPETA_RECHAZADOS),
    },
    intervaloVigilarSeg: e.ETL_INTERVALO_VIGILAR_SEG,
    diasStaging: e.ETL_DIAS_STAGING,
  };
  return cache!;
}
