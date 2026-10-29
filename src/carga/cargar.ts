// Carga completa de un archivo: registrar, leer, saber qué reporte es, validar, cuadrar, copiar a staging,
// publicar y refrescar. La Consulta de Tickets y el Reporte de compras siguen los mismos pasos, cada uno
// con su lector y su función de publicación.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { leerConfig, type Config } from '../config.js';
import { conCliente, esErrorDeConexion, explicarErrorConexion, type Cliente } from '../db.js';
import { abrirExcel, ErrorArchivo, type Hoja } from '../lector/excel.js';
import { procesarCompras } from '../reportes/compras/index.js';
import type { ResultadoCompras } from '../reportes/compras/tipos.js';
import { procesarHojas } from '../reportes/consulta-tickets/index.js';
import { tieneErrores, type ResultadoLectura } from '../reportes/consulta-tickets/tipos.js';
import { detectarTipo, type TipoReporte } from '../reportes/tipo.js';
import {
  avisosDeComprasEnLaBase,
  copiarComprasAStaging,
  ErrorSinTablasCompras,
  publicarCompras,
  tablasDeComprasInstaladas,
  type ConteosCompras,
} from './compras.js';
import { avisosDeLaBase, limpiarStaging, publicarEnDw, refrescarMart, type ConteosCarga } from './publicar.js';
import {
  buscarCargaDelMismoArchivo,
  guardarCuadre,
  guardarIncidencias,
  marcarLeida,
  marcarLeidaCompras,
  marcarRechazada,
  registrarCarga,
  sha256Archivo,
  type TipoCarga,
} from './registro.js';
import { copiarAStaging } from './staging.js';

export type EstadoCarga = 'CARGADO' | 'RECHAZADO' | 'DUPLICADO';

export interface ResultadoCarga {
  estado: EstadoCarga;
  /** Qué reporte era el archivo ('DESCONOCIDO' si ni siquiera se pudo abrir) */
  tipo: TipoCarga;
  archivo: string;
  cargaId: number | null;
  mensaje: string;
  segundos: number;
  lectura?: ResultadoLectura;
  conteos?: ConteosCarga;
  /** Solo en el Reporte de compras */
  compras?: ResultadoCompras;
  conteosCompras?: ConteosCompras;
  avisoMart?: string;
}

export interface OpcionesCarga {
  estacion?: string;
  usuario?: string;
}

/**
 * Aviso cuando la carga quedó guardada pero falló el refresco de las vistas de mart (los resúmenes del
 * Dashboard). Sale igual en el panel y en la consola. De un error de conexión va solo el diagnóstico (la
 * primera oración de explicarErrorConexion): sus consejos son para una carga que falló, y esta no hay que
 * repetirla. Cualquier otro error va como detalle técnico, para quien administra la base.
 */
function avisoDeResumenes(err: unknown): string {
  const explicacion = explicarErrorConexion(err);
  const diagnostico = /^.*?\.(?=\s|$)/.exec(explicacion)?.[0] ?? `${explicacion}.`;
  const causa = esErrorDeConexion(err) ? `. ${diagnostico}` : ` (detalle técnico: ${explicacion}).`;
  return (
    `La carga quedó guardada, pero no se pudieron poner al día los resúmenes del Dashboard${causa} ` +
    'No hace falta cargar el archivo otra vez: el Dashboard del panel intenta ponerlos al día solo cada vez que se abre, ' +
    'y la próxima carga también lo hace.'
  );
}

const n = (v: number) => v.toLocaleString('en-US');
const cuenta = (v: number, uno: string, varios: string) => `${n(v)} ${v === 1 ? uno : varios}`;

/** Lo común a las dos cargas, ya registrada la carga en etl.carga */
interface Contexto {
  c: Cliente;
  cargaId: number;
  nombre: string;
  hojas: Hoja[];
  estacion: string | undefined;
  config: Config;
  segundos: () => number;
}

export async function cargarArchivo(ruta: string, opciones: OpcionesCarga = {}): Promise<ResultadoCarga> {
  const inicio = Date.now();
  const config = leerConfig();
  const nombre = path.basename(ruta);
  const segundos = () => Math.round((Date.now() - inicio) / 100) / 10;
  const bytes = (await stat(ruta)).size;
  const sha256 = await sha256Archivo(ruta);
  const usuario = opciones.usuario ?? config.usuario;

  return conCliente(async (c) => {
    // 1) El mismo archivo (mismo contenido) no se procesa dos veces
    const previa = await buscarCargaDelMismoArchivo(c, sha256);
    if (previa) {
      const mensaje = `Este archivo ya se cargó en la carga ${previa.carga_id} (${previa.archivo_nombre}, ${previa.terminado_en.toLocaleString('es-GT')}). No se cargó otra vez.`;
      const cargaId = await registrarCarga(c, { tipo: previa.tipo_reporte, nombre, sha256, bytes, usuario, estado: 'DUPLICADO', mensaje });
      return { estado: 'DUPLICADO', tipo: previa.tipo_reporte, archivo: nombre, cargaId, mensaje, segundos: segundos() };
    }

    // 2) Abrir el Excel y ver qué reporte es (por sus columnas)
    let hojas: Hoja[];
    try {
      hojas = await abrirExcel(ruta);
    } catch (err) {
      const mensaje = err instanceof ErrorArchivo ? err.message : `Error al leer el archivo: ${(err as Error).message}`;
      const cargaId = await registrarCarga(c, { tipo: 'DESCONOCIDO', nombre, sha256, bytes, usuario });
      await marcarRechazada(c, cargaId, mensaje);
      return { estado: 'RECHAZADO', tipo: 'DESCONOCIDO', archivo: nombre, cargaId, mensaje, segundos: segundos() };
    }
    const tipo: TipoReporte = detectarTipo(hojas);
    const cargaId = await registrarCarga(c, { tipo, nombre, sha256, bytes, usuario });
    const ctx: Contexto = { c, cargaId, nombre, hojas, estacion: opciones.estacion ?? config.estacionPorDefecto, config, segundos };
    return tipo === 'COMPRAS' ? cargarCompras(ctx) : cargarTickets(ctx);
  });
}

async function cargarTickets({ c, cargaId, nombre, hojas, estacion, config, segundos }: Contexto): Promise<ResultadoCarga> {
  const tipo = 'CONSULTA_TICKETS';
  // Leer, validar y cuadrar (en memoria, sin tocar el modelo)
  let lectura: ResultadoLectura;
  try {
    lectura = procesarHojas(hojas, { estacion });
  } catch (err) {
    const mensaje = `Error al leer el archivo: ${(err as Error).message}`;
    await marcarRechazada(c, cargaId, mensaje);
    return { estado: 'RECHAZADO', tipo, archivo: nombre, cargaId, mensaje, segundos: segundos() };
  }
  await guardarIncidencias(c, cargaId, lectura.incidencias);
  await guardarCuadre(c, cargaId, lectura.cuadre);

  if (tieneErrores(lectura.incidencias)) {
    const errores = lectura.incidencias.filter((i) => i.severidad === 'ERROR');
    const mensaje = `${errores.length === 1 ? '1 error' : `${errores.length} errores`}; no se cargó nada. ${errores[0]!.mensaje}`;
    await marcarLeida(c, cargaId, lectura, 'RECHAZADO', mensaje);
    return { estado: 'RECHAZADO', tipo, archivo: nombre, cargaId, mensaje, segundos: segundos(), lectura };
  }
  await marcarLeida(c, cargaId, lectura, 'VALIDADO', null);

  // Staging y estrella en una sola transacción: entra todo o no entra nada
  let conteos: ConteosCarga;
  try {
    await c.query('BEGIN');
    await copiarAStaging(c, cargaId, lectura.tickets);
    conteos = await publicarEnDw(c, cargaId);
    await c.query('COMMIT');
  } catch (err) {
    const rechazo = await rechazarPorErrorEnLaBase(c, cargaId, err);
    return { estado: 'RECHAZADO', tipo, archivo: nombre, cargaId, mensaje: rechazo, segundos: segundos(), lectura };
  }

  lectura.incidencias.push(...(await avisosDeLaBase(c, cargaId)));

  // Refrescar los agregados y limpiar staging viejo. Si falla, la carga ya quedó hecha
  let avisoMart: string | undefined;
  try {
    await refrescarMart(c);
  } catch (err) {
    avisoMart = avisoDeResumenes(err);
  }
  await limpiarStaging(c, config.diasStaging).catch(() => undefined);

  // Este texto sale en el panel y en la consola: los tickets que no vinieron se ven en el Historial de cargas
  const mensaje =
    `${cuenta(conteos.insertadas, 'ticket nuevo', 'tickets nuevos')}, ${cuenta(conteos.actualizadas, 'actualizado', 'actualizados')} ` +
    `y ${n(conteos.sin_cambio)} sin cambio` +
    (conteos.movidas ? `, ${cuenta(conteos.movidas, 'cambió', 'cambiaron')} de fecha` : '') +
    (conteos.no_vinieron
      ? `; ${cuenta(conteos.no_vinieron, 'ticket ya cargado no vino', 'tickets ya cargados no vinieron')} en este archivo ` +
        '(el detalle está en el Historial de cargas del panel)'
      : '');
  return { estado: 'CARGADO', tipo, archivo: nombre, cargaId, mensaje, segundos: segundos(), lectura, conteos, avisoMart };
}

async function cargarCompras({ c, cargaId, nombre, hojas, estacion, config, segundos }: Contexto): Promise<ResultadoCarga> {
  const tipo = 'COMPRAS';
  let compras: ResultadoCompras;
  try {
    compras = procesarCompras(hojas, { estacion });
  } catch (err) {
    const mensaje = `Error al leer el archivo: ${(err as Error).message}`;
    await marcarRechazada(c, cargaId, mensaje);
    return { estado: 'RECHAZADO', tipo, archivo: nombre, cargaId, mensaje, segundos: segundos() };
  }
  await guardarIncidencias(c, cargaId, compras.incidencias);
  await guardarCuadre(c, cargaId, compras.cuadre);

  if (tieneErrores(compras.incidencias)) {
    const errores = compras.incidencias.filter((i) => i.severidad === 'ERROR');
    const mensaje = `${errores.length === 1 ? '1 error' : `${errores.length} errores`}; no se cargó nada. ${errores[0]!.mensaje}`;
    await marcarLeidaCompras(c, cargaId, compras, 'RECHAZADO', mensaje);
    return { estado: 'RECHAZADO', tipo, archivo: nombre, cargaId, mensaje, segundos: segundos(), compras };
  }
  // Una base sin la actualización 1.1.0 no puede recibir compras: se dice así, no como error de conexión
  if (!(await tablasDeComprasInstaladas(c))) {
    const mensaje = new ErrorSinTablasCompras().message;
    await marcarLeidaCompras(c, cargaId, compras, 'RECHAZADO', mensaje);
    return { estado: 'RECHAZADO', tipo, archivo: nombre, cargaId, mensaje, segundos: segundos(), compras };
  }
  await marcarLeidaCompras(c, cargaId, compras, 'VALIDADO', null);

  let conteos: ConteosCompras;
  try {
    await c.query('BEGIN');
    await copiarComprasAStaging(c, cargaId, compras.compras);
    conteos = await publicarCompras(c, cargaId);
    await c.query('COMMIT');
  } catch (err) {
    const rechazo = await rechazarPorErrorEnLaBase(c, cargaId, err);
    return { estado: 'RECHAZADO', tipo, archivo: nombre, cargaId, mensaje: rechazo, segundos: segundos(), compras };
  }

  compras.incidencias.push(...(await avisosDeComprasEnLaBase(c, cargaId)));
  await c
    .query(
      `DELETE FROM stg.compra s USING etl.carga k
        WHERE s.carga_id = k.carga_id AND k.iniciado_en < now() - make_interval(days => $1)`,
      [config.diasStaging],
    )
    .catch(() => undefined);

  const mensaje =
    `${cuenta(conteos.insertadas, 'compra nueva', 'compras nuevas')}, ${cuenta(conteos.actualizadas, 'actualizada', 'actualizadas')} ` +
    `y ${n(conteos.sin_cambio)} sin cambio` +
    (conteos.no_vinieron
      ? `; ${cuenta(conteos.no_vinieron, 'compra ya cargada no vino', 'compras ya cargadas no vinieron')} en este archivo ` +
        '(siguen contando en el inventario; el detalle está en el Historial de cargas)'
      : '');
  return { estado: 'CARGADO', tipo, archivo: nombre, cargaId, mensaje, segundos: segundos(), compras, conteosCompras: conteos };
}

/**
 * Deshace la transacción de staging y estrella. Sin conexión no se puede anotar nada: el error sube para
 * que el archivo se reintente (vigilar lo deja en entrada). Si no, la carga queda rechazada con el motivo.
 */
async function rechazarPorErrorEnLaBase(c: Cliente, cargaId: number, err: unknown): Promise<string> {
  await c.query('ROLLBACK').catch(() => undefined);
  if (esErrorDeConexion(err)) throw err;
  const e = err as { code?: string; message?: string };
  // Otra carga del mismo archivo terminó primero (índice único de archivos cargados)
  const mensaje =
    e.code === '23505' && /ux_carga_archivo_cargado/.test(e.message ?? '')
      ? 'Otra carga del mismo archivo terminó primero; esta no se aplicó.'
      : `Error al cargar en PostgreSQL: ${explicarErrorConexion(err)}`;
  await marcarRechazada(c, cargaId, mensaje).catch(() => {
    throw err;
  });
  return mensaje;
}
