// Conexión a PostgreSQL con los datos del .env
import pg from 'pg';
import { CONTRASENA_DE_EJEMPLO, ErrorConfiguracion, leerConfig } from './config.js';

// Los numeric llegan como texto para no perder decimales; los bigint (count) como número
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Cliente = pg.PoolClient;

let pool: pg.Pool | undefined;

export function opcionesConexion(baseDeDatos?: string): pg.PoolConfig {
  const { bd } = leerConfig();
  if (bd.password === CONTRASENA_DE_EJEMPLO) {
    throw new ErrorConfiguracion(
      'El .env todavía tiene la contraseña de ejemplo. Pon en PGPASSWORD la contraseña de tu PostgreSQL (en Dokploy: Internal Credentials).',
    );
  }
  // Sin contraseña pg falla a mitad del saludo SCRAM y deja la conexión abierta hasta que el servidor la corta (60 s)
  if (bd.password === '') {
    throw new ErrorConfiguracion(
      'Falta la contraseña: escribe en PGPASSWORD del .env la contraseña de tu PostgreSQL (en Dokploy: Internal Credentials).',
    );
  }
  return {
    host: bd.host,
    port: bd.port,
    database: baseDeDatos ?? bd.database,
    user: bd.user,
    password: bd.password,
    ssl: bd.ssl === false ? false : bd.ssl,
    application_name: 'etl_gas_station',
    connectionTimeoutMillis: 15000,
    // Si el servidor desaparece sin cerrar la conexión (se apaga, se corta la red), sin keepAlive la consulta esperaría
    // para siempre; así el sistema lo nota en unos 20 s y la consulta falla con ETIMEDOUT.
    // No se pone query_timeout: una carga (COPY y dw.cargar_tickets en una transacción) puede tardar minutos
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  };
}

export function obtenerPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ ...opcionesConexion(), max: 4 });
    // Un error en una conexión ociosa no debe tumbar el proceso (por ejemplo, en modo vigilar)
    pool.on('error', (err) => console.error('Conexión a PostgreSQL perdida:', err.message));
  }
  return pool;
}

/** Conexiones del pool ocupadas o conectándose: hay una consulta o una carga en curso */
export const consultasEnCurso = (): number => (pool ? pool.totalCount - pool.idleCount : 0);

export async function cerrarPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

// pg avisa con un evento 'error' si la conexión se cae; sin quien lo escuche, Node termina el proceso.
// El error igual llega a la consulta que estaba corriendo, que es donde se maneja
export const ignorarEventoError = (c: { on(evento: 'error', fn: () => void): unknown }) => c.on('error', () => undefined);

export async function conCliente<T>(fn: (c: Cliente) => Promise<T>): Promise<T> {
  const cliente = await obtenerPool().connect();
  const ignorar = () => undefined;
  cliente.on('error', ignorar);
  try {
    return await fn(cliente);
  } finally {
    cliente.removeListener('error', ignorar);
    cliente.release();
  }
}

// Errores que vienen de la conexión (red, autenticación, servidor no disponible) o de una base sin instalar
const CODIGOS_CONEXION = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '28P01',
  '28000',
  '3D000',
  '42P01',
  '3F000',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

type ErrorConCodigo = { code?: string; message?: string; path?: string; syscall?: string };

// pg-pool tampoco: con las conexiones del pool ocupadas, la consulta que espera turno falla con este mensaje
const esperaDelPool = (e: ErrorConCodigo) => /timeout exceeded when trying to connect/i.test(e.message ?? '');

// pg no le pone código al error cuando se agota connectionTimeoutMillis, solo el mensaje
const esTiempoAgotado = (e: ErrorConCodigo) =>
  (e.code === 'ETIMEDOUT' && e.path === undefined) || /connection timeout|timeout expired/i.test(e.message ?? '') || esperaDelPool(e);

// Con keepAlive, una conexión que ya funcionaba y dejó de responder falla al leer o escribir, no al conectar
const conexionPerdida = (e: ErrorConCodigo) => e.code === 'ETIMEDOUT' && (e.syscall === 'read' || e.syscall === 'write');

// Con PGPASSWORD vacío pg falla antes de llegar al servidor, sin código
const faltaContrasena = (e: ErrorConCodigo) => /client password must be a (non-empty )?string/i.test(e.message ?? '');

const conexionCortada = (e: ErrorConCodigo) =>
  /connection terminated unexpectedly|connection error and is not queryable/i.test(e.message ?? '');

const sinSsl = (e: ErrorConCodigo) => /does not support SSL connections/i.test(e.message ?? '');

const CODIGOS_CERTIFICADO = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
]);

const errorDeCertificado = (e: ErrorConCodigo) =>
  (e.code ?? '').startsWith('ERR_TLS_') || CODIGOS_CERTIFICADO.has(e.code ?? '') || /certificate/i.test(e.message ?? '');

// Un firewall o antivirus de la PC que bloquea la salida da EACCES/EPERM en connect, sin path
const bloqueadoEnLaPc = (e: ErrorConCodigo) => (e.code === 'EACCES' || e.code === 'EPERM') && e.syscall === 'connect';

export const esErrorDeConexion = (err: unknown): boolean => {
  const e = (err ?? {}) as ErrorConCodigo;
  // Los errores de archivos (EACCES, ETIMEDOUT en una carpeta de red...) traen path; los de red no
  const deConexion = e.code !== undefined && CODIGOS_CONEXION.has(e.code) && e.path === undefined;
  return (
    deConexion ||
    esTiempoAgotado(e) ||
    faltaContrasena(e) ||
    conexionCortada(e) ||
    sinSsl(e) ||
    errorDeCertificado(e) ||
    bloqueadoEnLaPc(e)
  );
};

/** Traduce los errores de conexión más comunes a un mensaje que se entienda */
export function explicarErrorConexion(err: unknown): string {
  const e = (err ?? {}) as ErrorConCodigo;
  // Sin .env (por ejemplo en validar) no hay datos de conexión, pero el mensaje no debe fallar
  let bd = { host: '?', port: 0, database: '?', user: '?' };
  try {
    bd = leerConfig().bd;
  } catch {
    // se usan los signos de interrogación
  }
  if (esperaDelPool(e)) {
    return (
      `El servidor ${bd.host}:${bd.port} no responde o está ocupado: había varias consultas esperando y se agotó el tiempo de espera. ` +
      'Espera un momento y vuelve a intentar; si sigue igual, revisa la conexión a internet y que la base esté corriendo.'
    );
  }
  if (conexionPerdida(e)) {
    return (
      `Se perdió la conexión con el servidor ${bd.host}:${bd.port} (dejó de responder a mitad de una consulta). ` +
      'Revisa la conexión a internet y vuelve a intentar. Si se estaba cargando un archivo, cárgalo otra vez: ' +
      'si ya había quedado guardado, saldrá como repetido.'
    );
  }
  if (esTiempoAgotado(e)) {
    return (
      `El servidor ${bd.host}:${bd.port} no responde (se agotó el tiempo de espera). ` +
      'Revisa PGHOST y PGPORT en el .env; si es el servidor Dokploy, que el External Port esté guardado y desplegado ' +
      'y que el firewall del servidor deje pasar ese puerto.'
    );
  }
  if (faltaContrasena(e)) {
    return 'Falta la contraseña: escribe en PGPASSWORD del .env la contraseña de tu PostgreSQL (en Dokploy: Internal Credentials).';
  }
  if (conexionCortada(e)) {
    return (
      `El servidor ${bd.host}:${bd.port} cerró la conexión. Revisa que PGPORT sea el puerto de PostgreSQL y que la base esté corriendo; ` +
      'si se estaba cargando un archivo, vuelve a intentarlo.'
    );
  }
  if (sinSsl(e)) {
    return 'El servidor no acepta conexión cifrada: pon PGSSL=false en el .env (el PostgreSQL de Dokploy no usa SSL).';
  }
  if (errorDeCertificado(e)) {
    return `No se pudo verificar el certificado SSL de ${bd.host}. Revisa PGSSL y PGSSL_CA en el .env.`;
  }
  if (bloqueadoEnLaPc(e)) {
    return `Algo en esta PC (firewall o antivirus) bloquea la conexión a ${bd.host}:${bd.port}.`;
  }
  switch (e.code) {
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `No hay ruta hacia el servidor ${bd.host}. Revisa PGHOST en el .env y la conexión a internet.`;
    case 'ECONNREFUSED':
      return (
        `No hay un PostgreSQL escuchando en ${bd.host}:${bd.port}. ` +
        'Si es el servidor Dokploy, revisa que el External Port esté guardado y desplegado (Deploy) y que la base esté corriendo; ' +
        'revisa también PGHOST y PGPORT en el .env.'
      );
    case 'ECONNRESET':
      return `El servidor ${bd.host}:${bd.port} cortó la conexión. Revisa que ese puerto sea el de PostgreSQL y si exige SSL (PGSSL en el .env).`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `No se encuentra el servidor "${bd.host}". Revisa PGHOST en el .env.`;
    case '28P01':
      return `Usuario o contraseña incorrectos para "${bd.user}". Revisa PGUSER y PGPASSWORD en el .env.`;
    case '28000':
      return `PostgreSQL no permite entrar al usuario "${bd.user}" desde esta máquina (pg_hba.conf).`;
    case '3D000':
      return `La base de datos "${bd.database}" no existe en ${bd.host}. Revisa PGDATABASE en el .env (en Dokploy es gas_station_db).`;
    case '42P01':
    case '3F000':
      return `La base "${bd.database}" no tiene las tablas del ETL. Instálalas con: npm run instalar-bd`;
    case '57P01':
    case '57P02':
      return `PostgreSQL en ${bd.host}:${bd.port} se reinició o se detuvo (por ejemplo, durante un Deploy en Dokploy) y cortó la conexión. Espera un momento y vuelve a intentar.`;
    case '57P03':
      return `PostgreSQL en ${bd.host}:${bd.port} se está iniciando o reiniciando (por ejemplo, durante un Deploy en Dokploy). Espera un momento y vuelve a intentar.`;
    case '53300':
      return `PostgreSQL en ${bd.host}:${bd.port} no acepta más conexiones (hay demasiadas abiertas). Vuelve a intentar en un momento.`;
    default:
      return e.message ?? String(err);
  }
}
