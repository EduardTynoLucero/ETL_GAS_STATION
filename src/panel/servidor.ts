// Panel web del ETL: subir el reporte, revisar lo que se va a cargar, cargarlo y ver el dashboard.
// Uso: npm run panel  (abre http://localhost:3100). Con --red se puede abrir desde otras PCs de la red.
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { open, type FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { CARPETA_PROYECTO } from '../config.js';
import { cerrarPool, consultasEnCurso } from '../db.js';
import { atenderApi, cargaEnProgreso, responder } from './api.js';

const CARPETA_PANEL = path.join(CARPETA_PROYECTO, 'panel');
const ECHARTS = path.join(CARPETA_PROYECTO, 'node_modules', 'echarts', 'dist', 'echarts.min.js');

const argumentos = process.argv.slice(2);
const enRed = argumentos.includes('--red');
const puerto = Number(process.env.PANEL_PUERTO || 3100);
const abrirNavegador = !argumentos.includes('--no-abrir') && process.env.PANEL_ABRIR !== 'false';

if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
  console.error(`PANEL_PUERTO="${process.env.PANEL_PUERTO}" no es un puerto válido. Usa un número entre 1 y 65535, por ejemplo 3100.`);
  process.exit(1);
}

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const CABECERAS_SEGURIDAD = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// El archivo se abre antes de responder: si no se puede leer (se borró, el antivirus lo bloquea) todavía se puede contestar
async function servirArchivo(res: ServerResponse, ruta: string): Promise<void> {
  let archivo: FileHandle | undefined;
  try {
    archivo = await open(ruta, 'r');
    if (!(await archivo.stat()).isFile()) throw Object.assign(new Error('no es archivo'), { code: 'EISDIR' });
  } catch (err) {
    await archivo?.close().catch(() => undefined);
    const codigo = (err as NodeJS.ErrnoException).code;
    const noExiste = codigo === 'ENOENT' || codigo === 'ENOTDIR' || codigo === 'EISDIR';
    if (!noExiste) console.error(`No se pudo abrir ${ruta}: ${(err as Error).message}`);
    res.writeHead(noExiste ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(noExiste ? 'No encontrado' : 'No se pudo leer el archivo');
    return;
  }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(ruta).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  if (res.req.method === 'HEAD') {
    await archivo.close();
    res.end();
    return;
  }
  // pipeline cierra el archivo también si la descarga se corta (por ejemplo, al recargar la página)
  pipeline(archivo.createReadStream(), res, (err) => {
    if (!err) return;
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(`No se pudo enviar ${ruta}: ${err.message}`);
    res.destroy();
  });
}

/** Solo archivos dentro de panel/: nada de "../" para leer otras carpetas */
function rutaEstatica(pathname: string): string | null {
  let relativa: string;
  try {
    relativa = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (relativa === '/' || relativa === '') relativa = '/index.html';
  const completa = path.resolve(CARPETA_PANEL, `.${relativa}`);
  return completa.startsWith(CARPETA_PANEL + path.sep) ? completa : null;
}

// Si alguien abre una página maliciosa en el navegador, esa página no debe poder usar el panel:
// en modo local solo se aceptan peticiones dirigidas a localhost, y los POST solo desde el mismo panel
function peticionPermitida(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!enRed && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origen = req.headers.origin;
    if (origen) {
      try {
        if (new URL(origen).host.toLowerCase() !== host) return false;
      } catch {
        return false;
      }
    } else if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
      return false;
    }
  }
  return true;
}

// Un error al atender una petición corta solo esa petición, no el panel (ni una carga que esté en curso)
function falloEnPeticion(res: ServerResponse, err: unknown): void {
  console.error(`Error inesperado al atender ${res.req.method} ${res.req.url}:`, err);
  try {
    if (!res.headersSent) responder(res, 500, { error: `Error inesperado: ${(err as Error)?.message ?? String(err)}` });
    else res.destroy();
  } catch {
    res.destroy();
  }
}

function atender(req: IncomingMessage, res: ServerResponse): void {
  for (const [k, v] of Object.entries(CABECERAS_SEGURIDAD)) res.setHeader(k, v);
  if (!peticionPermitida(req)) {
    responder(res, 403, { error: 'Petición no permitida. Abre el panel desde http://localhost:' + puerto });
    return;
  }
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    // Node deja pasar direcciones como "//::" o "http://[" que URL no puede leer
    responder(res, 400, { error: 'La dirección pedida no es válida.' });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    atenderApi(req, res, url).catch((err) => falloEnPeticion(res, err));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === '/vendor/echarts.min.js') {
    servirArchivo(res, ECHARTS).catch((err) => falloEnPeticion(res, err));
    return;
  }
  const ruta = rutaEstatica(url.pathname);
  if (!ruta) {
    res.writeHead(404).end();
    return;
  }
  servirArchivo(res, ruta).catch((err) => falloEnPeticion(res, err));
}

// Cada petición corre con su respuesta guardada: así un error que se escapa (un evento 'error' sin escuchar)
// se puede atribuir a la petición que lo causó
const peticionActual = new AsyncLocalStorage<ServerResponse>();

const servidor = createServer((req, res) => {
  peticionActual.run(res, () => {
    try {
      atender(req, res);
    } catch (err) {
      falloEnPeticion(res, err);
    }
  });
});

// Si el error salió de una petición, el panel sigue abierto: una excepción (un stream que falló) deja esa petición
// sin terminar y se corta; una promesa rechazada sin catch viene de algo suelto y la petición responde sola.
// Fuera de una petición no se sabe qué quedó a medias: se anota y el panel se cierra
function errorSinCapturar(err: unknown, cortarPeticion: boolean): void {
  const res = peticionActual.getStore();
  if (!res) {
    console.error('Error inesperado en el panel; se cierra para no seguir con algo a medias. Vuelve a abrirlo con npm run panel.', err);
    process.exit(1);
  }
  if (cortarPeticion) falloEnPeticion(res, err);
  else console.error(`Error inesperado al atender ${res.req.method} ${res.req.url} (la petición sigue):`, err);
}
process.on('uncaughtException', (err) => errorSinCapturar(err, true));
process.on('unhandledRejection', (motivo) => errorSinCapturar(motivo, false));

// Un archivo grande no debe cortarse a medio subir
servidor.requestTimeout = 10 * 60 * 1000;

function direccionesDeRed(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
}

function abrir(url: string): void {
  const [comando, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const hijo = spawn(comando, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
    hijo.on('error', () => undefined);
    hijo.unref();
  } catch {
    // sin navegador (por ejemplo en un servidor): se abre a mano
  }
}

servidor.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `El puerto ${puerto} ya está en uso: quizás el panel ya está abierto en otra ventana. ` +
        `Abre http://localhost:${puerto} en el navegador, o pon otro puerto en PANEL_PUERTO del .env.`,
    );
  } else if (err.code === 'EACCES') {
    console.error(`Windows no deja usar el puerto ${puerto}. Pon otro puerto en PANEL_PUERTO del .env, por ejemplo 3100.`);
  } else {
    console.error(`No se pudo abrir el panel: ${err.message}`);
  }
  process.exit(1);
});

servidor.listen(puerto, enRed ? '0.0.0.0' : '127.0.0.1', () => {
  const local = `http://localhost:${puerto}`;
  console.log(`Panel del ETL abierto en ${local}`);
  if (enRed) for (const ip of direccionesDeRed()) console.log(`  Desde otra PC de la red: http://${ip}:${puerto}`);
  console.log('Deja esta ventana abierta mientras usas el panel. Ctrl+C para cerrarlo.');
  if (abrirNavegador) abrir(local);
});

let cerrando = false;
async function cerrar(): Promise<void> {
  // El segundo Ctrl+C cierra sin esperar a PostgreSQL
  if (cerrando) {
    console.log('Cerrando sin esperar a PostgreSQL.');
    process.exit(130);
  }
  cerrando = true;
  console.log('\nCerrando el panel...');
  const archivo = cargaEnProgreso();
  if (archivo) {
    console.log(
      `Se está cargando ${archivo}: se espera hasta 5 segundos a que termine (Ctrl+C otra vez para cerrar ya). ` +
        'Si no alcanza a terminar, no queda nada a medias: vuelve a cargarlo cuando abras el panel (si ya había quedado guardado, saldrá como repetido).',
    );
  } else if (consultasEnCurso() > 0) {
    console.log(
      'Hay una consulta o una carga en curso: se espera hasta 5 segundos a que termine (Ctrl+C otra vez para cerrar ya). ' +
        'Si se estaba cargando un archivo y no alcanza a terminar, cárgalo otra vez cuando abras el panel: si ya había quedado guardado, saldrá como repetido.',
    );
  }
  servidor.close();
  servidor.closeAllConnections();
  // cerrarPool espera a las consultas ocupadas; una consulta colgada no debe dejar la ventana sin poder cerrarse
  setTimeout(() => {
    console.log('PostgreSQL no terminó en 5 segundos: el panel se cierra sin esperar.');
    process.exit(0);
  }, 5000).unref();
  await cerrarPool().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void cerrar());
process.on('SIGTERM', () => void cerrar());
