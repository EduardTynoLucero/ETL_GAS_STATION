// Registro de cada carga en etl.carga, con sus incidencias y su cuadre.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Cliente } from '../db.js';
import type { Incidencia, ResultadoLectura } from '../reportes/consulta-tickets/tipos.js';
import type { ResultadoCompras } from '../reportes/compras/tipos.js';
import type { TipoReporte } from '../reportes/tipo.js';

/** Un archivo que ni siquiera se pudo abrir no se sabe de qué reporte es */
export type TipoCarga = TipoReporte | 'DESCONOCIDO';

/** Una fila de cuadre de cualquier reporte (tickets o compras) */
export interface FilaCuadreGuardada {
  grupo: string;
  medida: string;
  tickets: number;
  sumaDetalle: { toFixed(): string };
  valorReporte: { toFixed(): string };
  tolerancia: { toFixed(): string };
}

export function sha256Archivo(ruta: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(ruta)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

export interface CargaPrevia {
  carga_id: number;
  terminado_en: Date;
  archivo_nombre: string;
  tipo_reporte: TipoCarga;
}

/** El mismo contenido no puede ser de dos reportes: se busca sin mirar el tipo */
export async function buscarCargaDelMismoArchivo(c: Cliente, sha256: string): Promise<CargaPrevia | null> {
  const r = await c.query<CargaPrevia>(
    `SELECT carga_id, terminado_en, archivo_nombre, tipo_reporte FROM etl.carga
      WHERE archivo_sha256 = $1 AND estado = 'CARGADO' ORDER BY carga_id LIMIT 1`,
    [sha256],
  );
  return r.rows[0] ?? null;
}

export async function registrarCarga(
  c: Cliente,
  datos: { tipo: TipoCarga; nombre: string; sha256: string; bytes: number; usuario: string; estado?: 'RECIBIDO' | 'DUPLICADO'; mensaje?: string },
): Promise<number> {
  const r = await c.query<{ carga_id: number }>(
    `INSERT INTO etl.carga (tipo_reporte, archivo_nombre, archivo_sha256, archivo_bytes, usuario, estado, mensaje, terminado_en)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 = 'DUPLICADO' THEN now() END)
     RETURNING carga_id`,
    [datos.tipo, datos.nombre, datos.sha256, datos.bytes, datos.usuario, datos.estado ?? 'RECIBIDO', datos.mensaje ?? null],
  );
  return r.rows[0]!.carga_id;
}

export async function guardarIncidencias(c: Cliente, cargaId: number, incidencias: Incidencia[]): Promise<void> {
  if (incidencias.length === 0) return;
  await c.query(
    `INSERT INTO etl.incidencia (carga_id, fila_excel, ticket_numero, severidad, regla, columna, valor, mensaje)
     SELECT $1::bigint, * FROM unnest($2::int[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])`,
    [
      cargaId,
      incidencias.map((i) => i.fila ?? null),
      incidencias.map((i) => i.ticket ?? null),
      incidencias.map((i) => i.severidad),
      incidencias.map((i) => i.regla),
      incidencias.map((i) => i.columna ?? null),
      incidencias.map((i) => i.valor ?? null),
      incidencias.map((i) => i.mensaje),
    ],
  );
}

export async function guardarCuadre(c: Cliente, cargaId: number, filas: FilaCuadreGuardada[]): Promise<void> {
  if (filas.length === 0) return;
  await c.query(
    `INSERT INTO etl.cuadre (carga_id, grupo, medida, tickets, suma_detalle, valor_reporte, tolerancia)
     SELECT $1::bigint, * FROM unnest($2::text[], $3::text[], $4::int[], $5::numeric[], $6::numeric[], $7::numeric[])`,
    [
      cargaId,
      filas.map((f) => f.grupo),
      filas.map((f) => f.medida),
      filas.map((f) => f.tickets),
      filas.map((f) => f.sumaDetalle.toFixed()),
      filas.map((f) => f.valorReporte.toFixed()),
      filas.map((f) => f.tolerancia.toFixed()),
    ],
  );
}

/** Columnas detectadas y su orden: sirve para saber qué variante del reporte se subió */
export function variante(lectura: ResultadoLectura) {
  return {
    hoja: lectura.hoja,
    fila_encabezado: lectura.filaEncabezado,
    trae_estacion: lectura.traeEstacion,
    columnas: lectura.columnas.map((col) => ({ col: col.col, nombre: col.nombre, campo: col.campo })),
  };
}

export async function marcarLeida(
  c: Cliente,
  cargaId: number,
  lectura: ResultadoLectura,
  estado: 'VALIDADO' | 'RECHAZADO',
  mensaje: string | null,
): Promise<void> {
  const errores = lectura.incidencias.filter((i) => i.severidad === 'ERROR').length;
  await c.query(
    `UPDATE etl.carga
        SET estado = $2, variante = $3, filas_detalle = $4, rechazadas = $5, mensaje = $6,
            estacion_codigo = $7, turno_min = $8, turno_max = $9, fecha_min = $10, fecha_max = $11,
            terminado_en = CASE WHEN $2 = 'RECHAZADO' THEN now() END
      WHERE carga_id = $1`,
    [
      cargaId,
      estado,
      JSON.stringify(variante(lectura)),
      lectura.tickets.length,
      errores,
      mensaje,
      lectura.resumen.estaciones.join(',') || null,
      lectura.resumen.turnoMin,
      lectura.resumen.turnoMax,
      lectura.resumen.fechaMin,
      lectura.resumen.fechaMax,
    ],
  );
}

/** Igual que marcarLeida, para el Reporte de compras */
export async function marcarLeidaCompras(
  c: Cliente,
  cargaId: number,
  lectura: ResultadoCompras,
  estado: 'VALIDADO' | 'RECHAZADO',
  mensaje: string | null,
): Promise<void> {
  const errores = lectura.incidencias.filter((i) => i.severidad === 'ERROR').length;
  const variante = {
    hoja: lectura.hoja,
    fila_encabezado: lectura.filaEncabezado,
    columnas: lectura.columnas.map((col) => ({ col: col.col, nombre: col.nombre, campo: col.campo })),
  };
  await c.query(
    `UPDATE etl.carga
        SET estado = $2, variante = $3, filas_detalle = $4, rechazadas = $5, mensaje = $6,
            estacion_codigo = $7, turno_min = $8, turno_max = $9, fecha_min = $10, fecha_max = $11,
            terminado_en = CASE WHEN $2 = 'RECHAZADO' THEN now() END
      WHERE carga_id = $1`,
    [
      cargaId,
      estado,
      JSON.stringify(variante),
      lectura.compras.length,
      errores,
      mensaje,
      lectura.resumen.estaciones.join(',') || null,
      lectura.resumen.turnoMin,
      lectura.resumen.turnoMax,
      lectura.resumen.fechaMin,
      lectura.resumen.fechaMax,
    ],
  );
}

export async function marcarRechazada(c: Cliente, cargaId: number, mensaje: string): Promise<void> {
  await c.query(`UPDATE etl.carga SET estado = 'RECHAZADO', mensaje = $2, terminado_en = now() WHERE carga_id = $1`, [
    cargaId,
    mensaje.slice(0, 4000),
  ]);
}
