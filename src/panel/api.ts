// Rutas /api del panel: estado de la conexión, vista previa, carga, dashboard, inventario, toma física e historial.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ErrorConfiguracion, leerConfig } from '../config.js';
import { conCliente, esErrorDeConexion, explicarErrorConexion } from '../db.js';
import { probarConexion } from '../bd/instalar.js';
import { cargarArchivo, type ResultadoCarga } from '../carga/cargar.js';
import { mover, sello } from '../carga/vigilar.js';
import { ErrorArchivo } from '../lector/excel.js';
import { resumenJson } from '../resumen.js';
import { dashboard, detalleCarga, listaCargas, opciones } from './consultas.js';
import { inventario, opcionesInventario } from './inventario.js';
import { ErrorTanque, guardarTanque, nivelTanques } from './tanques.js';
import { anularToma, editarToma, ErrorToma, historialToma, listarTomas, opcionesTomas, registrarToma, restaurarToma } from './tomas.js';
import { compararConBase, crearVistaPrevia, obtenerPrevia, olvidarPrevia, ticketsDePrevia } from './vistaPrevia.js';

const MAX_ARCHIVO = 50 * 1024 * 1024;
const MAX_JSON = 64 * 1024;

export class ErrorHttp extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

/**
 * Lee el cuerpo completo con un límite. Si se pasa, responde 413 sin cortar la conexión: el resto
 * se descarta mientras llega, porque un corte a media subida le llega al navegador como "sin respuesta".
 */
function leerCuerpo(req: IncomingMessage, limite: number, mensajeLimite: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declarado = Number(req.headers['content-length']);
    if (Number.isFinite(declarado) && declarado > limite) {
      reject(new ErrorHttp(413, mensajeLimite));
      req.resume();
      return;
    }
    const partes: Buffer[] = [];
    let total = 0;
    let excedido = false;
    req.on('data', (d: Buffer) => {
      if (excedido) return;
      total += d.length;
      if (total > limite) {
        excedido = true;
        partes.length = 0;
        reject(new ErrorHttp(413, mensajeLimite));
        return;
      }
      partes.push(d);
    });
    req.on('end', () => {
      if (!excedido) resolve(Buffer.concat(partes));
    });
    req.on('error', reject);
  });
}

async function leerJson<T>(req: IncomingMessage, esquema: z.ZodType<T>): Promise<T> {
  const cuerpo = await leerCuerpo(req, MAX_JSON, 'La solicitud es demasiado grande.');
  let datos: unknown;
  try {
    datos = JSON.parse(cuerpo.toString('utf8') || '{}');
  } catch {
    throw new ErrorHttp(400, 'La solicitud no es JSON válido.');
  }
  const r = esquema.safeParse(datos);
  if (!r.success) throw new ErrorHttp(400, `Datos inválidos: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

export function responder(res: ServerResponse, estado: number, datos: unknown): void {
  const cuerpo = JSON.stringify(datos);
  res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(cuerpo);
}

/** Nombre de archivo que sirve en Windows: sin carpetas ni caracteres prohibidos */
function nombreSeguro(nombre: string): string {
  const base = path.basename(nombre.replace(/\\/g, '/'));
  let limpio = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  // Al recortar un nombre largo se conserva la extensión (si no, se rechazaría como "no es .xlsx")
  if (limpio.length > 150) {
    const extension = path.extname(limpio).slice(0, 10);
    limpio = limpio.slice(0, 150 - extension.length).trimEnd() + extension;
  }
  return limpio && limpio !== '.' && limpio !== '..' ? limpio : 'reporte.xlsx';
}

function decodificar(texto: string): string {
  try {
    return decodeURIComponent(texto);
  } catch {
    return texto;
  }
}

function datosConexion() {
  try {
    const { bd, estacionPorDefecto, usuario } = leerConfig();
    return { servidor: `${bd.host}:${bd.port}`, baseDeDatos: bd.database, usuario: bd.user, estacionPorDefecto: estacionPorDefecto ?? null, usuarioEtl: usuario };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'usa aaaa-mm-dd');
const textoCorto = z.string().trim().min(1).max(80);
const esquemaFiltros = z.object({
  desde: fecha.optional(),
  hasta: fecha.optional(),
  estacion: textoCorto.optional(),
  producto: textoCorto.optional(),
});

const esquemaTickets = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  porPagina: z.coerce.number().int().min(10).max(500).default(50),
  buscar: z.string().max(80).optional(),
  producto: textoCorto.optional(),
  filtro: z.enum(['todos', 'incidencias', 'sin-factura', 'nuevos', 'cambian']).default('todos'),
});

const esquemaCarga = z.object({
  token: z.string().uuid(),
  usuario: z.string().trim().max(60).optional(),
});

const esquemaInventario = z
  .object({ estacion: textoCorto, desde: fecha, hasta: fecha })
  .refine((f) => f.desde <= f.hasta, { message: 'la fecha Desde va antes que Hasta', path: ['desde'] });

/** Hoy en la hora de esta PC, aaaa-mm-dd */
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fechaToma = fecha.refine((f) => f <= hoy(), 'la toma no puede ser de una fecha futura');
const horaToma = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'usa hh:mm de 24 horas');
const galonesToma = z.number().finite().min(0, 'no puede ser negativo').max(1_000_000, 'es demasiado grande');
const usuarioToma = z.string().trim().max(60).optional();
const observacionesToma = z.string().trim().max(300).optional();

const esquemaToma = z.object({
  estacion: textoCorto,
  fecha: fechaToma,
  hora: horaToma,
  usuario: usuarioToma,
  observaciones: observacionesToma,
  lecturas: z
    .array(z.object({ producto: textoCorto, galones: galonesToma }))
    .min(1, 'escribe los galones de al menos un producto')
    .max(20)
    .refine((l) => new Set(l.map((x) => x.producto)).size === l.length, 'un producto viene dos veces'),
});

const esquemaEditarToma = z.object({ fecha: fechaToma, hora: horaToma, galones: galonesToma, usuario: usuarioToma, observaciones: observacionesToma });

const esquemaFiltrosTomas = z.object({
  estacion: textoCorto,
  desde: fecha.optional(),
  hasta: fecha.optional(),
  producto: textoCorto.optional(),
  estado: z.enum(['vigentes', 'anuladas', 'todas']).default('vigentes'),
});

const esquemaAnular = z.object({ usuario: z.string().trim().max(60).optional() });

const esquemaTanque = z
  .object({
    estacion: textoCorto,
    producto: textoCorto,
    usuario: usuarioToma,
    capacidad_galones: z.number().finite().gt(0, 'tiene que ser mayor que cero').max(1_000_000),
    tiempo_entrega_dias: z.number().finite().min(0).max(60),
    dias_seguridad: z.number().finite().min(0).max(60),
    nivel_minimo_pct: z.number().finite().min(0).max(100),
    llenado_maximo_pct: z.number().finite().min(1).max(100),
    multiplo_pedido: z.number().finite().gt(0).max(100_000),
    horizonte_dias: z.number().finite().gt(0).max(90),
    dias_consumo: z.number().int().min(3).max(90),
  })
  .refine((t) => t.nivel_minimo_pct < t.llenado_maximo_pct, { message: 'el mínimo tiene que ser menor que el llenado máximo', path: ['nivel_minimo_pct'] });

const parametros = (url: URL) => Object.fromEntries([...url.searchParams.entries()].filter(([, v]) => v.trim() !== ''));

function validar<T>(esquema: z.ZodType<T>, datos: unknown): T {
  const r = esquema.safeParse(datos);
  if (!r.success) throw new ErrorHttp(400, `Filtros inválidos: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

function previaOError(token: string) {
  const e = obtenerPrevia(token);
  if (!e) throw new ErrorHttp(404, 'La vista previa ya no está disponible (dura 30 minutos o se reinició el panel). Sube el archivo otra vez.');
  return e;
}

let cargaEnCurso: string | null = null;

/** Nombre del archivo que se está cargando ahora, o null (para avisar si se cierra el panel a media carga) */
export const cargaEnProgreso = (): string | null => cargaEnCurso;

async function cargar(req: IncomingMessage) {
  const { token, usuario } = await leerJson(req, esquemaCarga);
  const e = previaOError(token);
  if (cargaEnCurso) throw new ErrorHttp(409, `Ya se está cargando ${cargaEnCurso}. Espera a que termine.`);
  cargaEnCurso = e.nombre;
  const nombre = nombreSeguro(e.nombre);
  let carpetaTemporal: string | null = null;
  try {
    carpetaTemporal = await mkdtemp(path.join(os.tmpdir(), 'etl-gas-station-'));
    const ruta = path.join(carpetaTemporal, nombre);
    await writeFile(ruta, e.datos);
    const resultado: ResultadoCarga = await cargarArchivo(ruta, { estacion: e.estacion, usuario: usuario || undefined });

    // Copia del archivo original, igual que en la carpeta vigilada (un repetido no se guarda otra vez)
    let archivado: string | null = null;
    let avisoArchivo: string | null = null;
    if (resultado.estado !== 'DUPLICADO') {
      const { carpetas } = leerConfig();
      const carpeta = resultado.estado === 'RECHAZADO' ? carpetas.rechazados : carpetas.procesados;
      try {
        await mkdir(carpeta, { recursive: true });
        const destino = path.join(carpeta, `${sello()}_${nombre}`);
        await mover(ruta, destino);
        await writeFile(`${destino}.json`, JSON.stringify(resumenJson(resultado), null, 2), 'utf8');
        archivado = destino;
      } catch (err) {
        avisoArchivo = `La carga terminó, pero no se pudo guardar la copia del archivo en ${carpeta}: ${(err as Error).message}`;
      }
    }
    if (resultado.estado === 'CARGADO') olvidarPrevia(token);
    const { lectura, compras, ...resto } = resumenJson(resultado);
    return {
      ...resto,
      lectura: lectura ? { ...lectura, incidencias: undefined } : null,
      compras: compras ? { ...compras, incidencias: undefined } : null,
      archivado,
      avisoArchivo,
    };
  } finally {
    cargaEnCurso = null;
    if (carpetaTemporal) await rm(carpetaTemporal, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function estado() {
  const config = datosConexion();
  try {
    const bd = await probarConexion();
    const aviso = bd.esquemaInstalado ? null : 'La base no tiene las tablas del ETL. Instálalas con: npm run instalar-bd';
    return { conectado: true, tipo: null, error: aviso, config, bd };
  } catch (err) {
    const mensaje =
      err instanceof ErrorConfiguracion ? err.message : esErrorDeConexion(err) ? explicarErrorConexion(err) : (err as Error).message;
    return { conectado: false, tipo: err instanceof ErrorConfiguracion ? 'configuracion' : 'conexion', error: mensaje, config, bd: null };
  }
}

export async function atenderApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const ruta = url.pathname;
  const metodo = req.method ?? 'GET';
  try {
    if (metodo === 'GET' && ruta === '/api/estado') return responder(res, 200, await estado());

    if (metodo === 'POST' && ruta === '/api/vista-previa') {
      const nombre = nombreSeguro(decodificar(String(req.headers['x-archivo-nombre'] ?? 'reporte.xlsx')));
      if (!/\.xlsx$/i.test(nombre)) {
        throw new ErrorHttp(422, `"${nombre}" no es un archivo .xlsx. Sube la Consulta de Tickets o el Reporte de compras exportado de BISS en Excel.`);
      }
      const datos = await leerCuerpo(
        req,
        MAX_ARCHIVO,
        `El archivo pesa más de ${MAX_ARCHIVO / 1024 / 1024} MB. Revisa que sea la Consulta de Tickets o el Reporte de compras y no otro archivo.`,
      );
      if (datos.length === 0) throw new ErrorHttp(422, `"${nombre}" está vacío (0 bytes). Exporta el reporte otra vez.`);
      const estacion = url.searchParams.get('estacion') ?? undefined;
      return responder(res, 200, await crearVistaPrevia(datos, nombre, estacion));
    }

    let m = /^\/api\/vista-previa\/([0-9a-f-]{36})\/(comparar|tickets)$/.exec(ruta);
    if (metodo === 'GET' && m) {
      const e = previaOError(m[1]!);
      if (m[2] === 'comparar') return responder(res, 200, await compararConBase(e));
      // Las líneas del reporte de compras ya vienen todas en la vista previa
      if (e.tipo !== 'CONSULTA_TICKETS') throw new ErrorHttp(400, 'Este archivo es un Reporte de compras: no tiene tabla de tickets.');
      return responder(res, 200, ticketsDePrevia(e, validar(esquemaTickets, parametros(url))));
    }

    if (metodo === 'POST' && ruta === '/api/cargas') return responder(res, 200, await cargar(req));
    if (metodo === 'GET' && ruta === '/api/cargas') return responder(res, 200, await conCliente(listaCargas));
    m = /^\/api\/cargas\/(\d{1,12})$/.exec(ruta);
    if (metodo === 'GET' && m) {
      const detalle = await conCliente((c) => detalleCarga(c, Number(m![1])));
      if (!detalle) throw new ErrorHttp(404, `No existe la carga ${m[1]}.`);
      return responder(res, 200, detalle);
    }

    if (metodo === 'GET' && ruta === '/api/opciones') return responder(res, 200, await conCliente(opciones));
    if (metodo === 'GET' && ruta === '/api/dashboard') {
      const filtros = validar(esquemaFiltros, parametros(url));
      return responder(res, 200, await conCliente((c) => dashboard(c, filtros)));
    }

    // Inventario y toma física
    if (metodo === 'GET' && ruta === '/api/inventario/opciones') return responder(res, 200, await conCliente(opcionesInventario));
    if (metodo === 'GET' && ruta === '/api/inventario') {
      const filtros = validar(esquemaInventario, parametros(url));
      return responder(res, 200, await conCliente((c) => inventario(c, filtros)));
    }
    // Nivel de los tanques y su configuración
    if (metodo === 'GET' && ruta === '/api/tanques') {
      const { estacion } = validar(z.object({ estacion: textoCorto }), parametros(url));
      return responder(res, 200, await conCliente((c) => nivelTanques(c, estacion)));
    }
    if (metodo === 'PUT' && ruta === '/api/tanques') {
      const { estacion, producto, usuario, ...p } = await leerJson(req, esquemaTanque);
      return responder(res, 200, await conCliente((c) => guardarTanque(c, estacion, producto, p, usuario)));
    }

    // Toma física (CRUD): crear, listar, editar, anular, restaurar y bitácora
    if (metodo === 'GET' && ruta === '/api/tomas/opciones') return responder(res, 200, await conCliente(opcionesTomas));
    if (metodo === 'GET' && ruta === '/api/tomas') {
      const filtros = validar(esquemaFiltrosTomas, parametros(url));
      return responder(res, 200, await conCliente((c) => listarTomas(c, filtros)));
    }
    if (metodo === 'POST' && ruta === '/api/tomas') {
      const toma = await leerJson(req, esquemaToma);
      return responder(res, 200, await conCliente((c) => registrarToma(c, toma)));
    }
    m = /^\/api\/tomas\/(\d{1,12})$/.exec(ruta);
    if (metodo === 'PUT' && m) {
      const cambio = await leerJson(req, esquemaEditarToma);
      return responder(res, 200, await conCliente((c) => editarToma(c, Number(m![1]), cambio)));
    }
    m = /^\/api\/tomas\/(\d{1,12})\/(anular|restaurar)$/.exec(ruta);
    if (metodo === 'POST' && m) {
      const { usuario } = await leerJson(req, esquemaAnular);
      const id = Number(m[1]);
      const accion = m[2] === 'anular' ? anularToma : restaurarToma;
      return responder(res, 200, await conCliente((c): Promise<object> => accion(c, id, usuario)));
    }
    m = /^\/api\/tomas\/(\d{1,12})\/historial$/.exec(ruta);
    if (metodo === 'GET' && m) return responder(res, 200, await conCliente((c) => historialToma(c, Number(m![1]))));

    throw new ErrorHttp(404, `No existe la ruta ${metodo} ${ruta}.`);
  } catch (err) {
    if (err instanceof ErrorHttp) return responder(res, err.estado, { error: err.message });
    if (err instanceof ErrorToma || err instanceof ErrorTanque) return responder(res, 409, { error: err.message });
    if (err instanceof ErrorArchivo) return responder(res, 422, { error: err.message });
    if (err instanceof ErrorConfiguracion) return responder(res, 503, { error: err.message, tipo: 'configuracion' });
    if (esErrorDeConexion(err)) return responder(res, 503, { error: explicarErrorConexion(err), tipo: 'conexion' });
    console.error(`Error en ${metodo} ${ruta}:`, err);
    return responder(res, 500, { error: `Error inesperado: ${(err as Error).message}` });
  }
}
