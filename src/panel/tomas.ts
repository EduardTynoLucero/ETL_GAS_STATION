// Toma física: crear, consultar, editar, anular y restaurar mediciones de los tanques. Nada se borra: una toma
// equivocada se anula, y cada cambio queda en dw.toma_fisica_historial (lo llena un trigger, versión 1.2.0).
import type { Cliente } from '../db.js';

export class ErrorToma extends Error {}

const n = (sql: string, dec = 3) => `round((${sql})::numeric, ${dec})::float8`;

const SIN_TABLAS =
  'La base todavía no tiene la tabla de toma física. Ejecuta sql/actualizar_compras_inventario.sql y sql/actualizar_tomas_fisicas.sql (o npm run instalar-bd).';
const SIN_CRUD =
  'Para editar, restaurar y ver la bitácora de las tomas, la base necesita la versión 1.2.0: ejecuta sql/actualizar_tomas_fisicas.sql (o npm run instalar-bd).';

/** Qué tiene instalado la base: la tabla de tomas (1.1.0) y su edición con bitácora (1.2.0) */
async function instalado(c: Cliente): Promise<{ tomas: boolean; crud: boolean }> {
  const r = await c.query<{ tomas: boolean; crud: boolean }>(
    `SELECT to_regclass('dw.toma_fisica') IS NOT NULL AND to_regclass('mart.v_toma_fisica_diferencia') IS NOT NULL AS tomas,
            to_regclass('dw.toma_fisica_historial') IS NOT NULL AS crud`,
  );
  return r.rows[0]!;
}

async function exigir(c: Cliente, crud: boolean): Promise<void> {
  const i = await instalado(c);
  if (!i.tomas) throw new ErrorToma(SIN_TABLAS);
  if (crud && !i.crud) throw new ErrorToma(SIN_CRUD);
}

export async function opcionesTomas(c: Cliente) {
  const i = await instalado(c);
  if (!i.tomas || !i.crud) return { instalado: false as const, falta: i.tomas ? 'crud' : 'tomas' };
  const estaciones = await c.query<{ codigo: string; nombre: string }>(`SELECT codigo, nombre FROM dw.dim_estacion WHERE estacion_key <> -1 ORDER BY codigo`);
  const productos = await c.query<{ nombre: string }>(`SELECT nombre FROM dw.dim_producto WHERE familia = 'COMBUSTIBLE' ORDER BY producto_key`);
  return { instalado: true as const, estaciones: estaciones.rows, productos: productos.rows.map((p) => p.nombre) };
}

export interface FiltrosTomas {
  estacion: string;
  desde?: string; // aaaa-mm-dd, por fecha de la medición
  hasta?: string;
  producto?: string;
  estado: 'vigentes' | 'anuladas' | 'todas';
}

/**
 * Tomas de una estación con su diferencia contra la toma anterior del mismo producto (mart.v_toma_fisica_diferencia:
 * toma anterior + compras - ventas de en medio). Las anuladas no tienen diferencia: no cuentan en el inventario.
 */
export async function listarTomas(c: Cliente, f: FiltrosTomas) {
  await exigir(c, true);
  const params: unknown[] = [f.estacion];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  const cond = ['e.codigo = $1'];
  if (f.desde) cond.push(`t.fecha_hora >= ${p(f.desde)}::date`);
  if (f.hasta) cond.push(`t.fecha_hora < ${p(f.hasta)}::date + 1`);
  if (f.producto) cond.push(`pr.nombre = ${p(f.producto)}`);
  if (f.estado === 'vigentes') cond.push('NOT t.anulada');
  if (f.estado === 'anuladas') cond.push('t.anulada');
  const r = await c.query(
    `SELECT t.toma_id, pr.nombre AS producto,
            to_char(t.fecha_hora, 'YYYY-MM-DD') AS fecha, to_char(t.fecha_hora, 'HH24:MI') AS hora,
            to_char(t.fecha_hora, 'YYYY-MM-DD HH24:MI') AS fecha_hora,
            ${n('t.galones')} AS galones,
            ${n('d.galones_teoricos')} AS teorico, ${n('d.diferencia')} AS diferencia,
            to_char(d.toma_anterior_en, 'YYYY-MM-DD HH24:MI') AS toma_anterior_en,
            t.observaciones, t.usuario, t.registrada_en,
            t.modificada_en, t.modificada_por,
            t.anulada, t.anulada_en, t.anulada_por
       FROM dw.toma_fisica t
       JOIN dw.dim_estacion e  ON e.estacion_key = t.estacion_key
       JOIN dw.dim_producto pr ON pr.producto_key = t.producto_key
       LEFT JOIN mart.v_toma_fisica_diferencia d ON d.toma_id = t.toma_id
      WHERE ${cond.join(' AND ')}
      ORDER BY t.fecha_hora DESC, pr.producto_key
      LIMIT 500`,
    params,
  );
  return r.rows;
}

export interface NuevaToma {
  estacion: string;
  fecha: string; // aaaa-mm-dd
  hora: string; // hh:mm
  usuario?: string;
  observaciones?: string;
  lecturas: { producto: string; galones: number }[];
}

const fechaLegible = (fecha: string) => fecha.split('-').reverse().join('/');

/** Un 23505 del índice ux_toma_vigente: ya hay una toma vigente de ese producto a esa hora */
function siYaExiste(err: unknown, producto: string, fecha: string, hora: string): never {
  if ((err as { code?: string }).code === '23505') {
    throw new ErrorToma(
      `Ya hay una toma física vigente de ${producto} el ${fechaLegible(fecha)} a las ${hora}. ` +
        'Edita esa toma, o anúlala primero si esta es la correcta.',
    );
  }
  throw err;
}

/** Guarda una medición por producto, todas con la misma fecha y hora, en una sola transacción */
export async function registrarToma(c: Cliente, t: NuevaToma) {
  await exigir(c, false);
  const est = await c.query<{ estacion_key: number }>(`SELECT estacion_key FROM dw.dim_estacion WHERE codigo = $1 AND estacion_key <> -1`, [t.estacion]);
  if (!est.rows[0]) throw new ErrorToma(`No conozco la estación ${t.estacion}.`);
  const prods = await c.query<{ producto_key: number; nombre: string }>(
    `SELECT producto_key, nombre FROM dw.dim_producto WHERE familia = 'COMBUSTIBLE' AND nombre = ANY($1::text[])`,
    [t.lecturas.map((l) => l.producto)],
  );
  const claveDe = new Map(prods.rows.map((p) => [p.nombre, p.producto_key]));
  const desconocido = t.lecturas.find((l) => !claveDe.has(l.producto));
  if (desconocido) throw new ErrorToma(`${desconocido.producto} no es un combustible del modelo.`);
  try {
    await c.query('BEGIN');
    const r = await c.query<{ toma_id: number }>(
      `INSERT INTO dw.toma_fisica (estacion_key, producto_key, fecha_hora, galones, observaciones, usuario)
       SELECT $1, u.producto_key, $2::timestamp, u.galones, $3, $4
         FROM unnest($5::int[], $6::numeric[]) AS u(producto_key, galones)
       RETURNING toma_id`,
      [
        est.rows[0].estacion_key,
        `${t.fecha} ${t.hora}:00`,
        t.observaciones?.trim() || null,
        t.usuario?.trim() || null,
        t.lecturas.map((l) => claveDe.get(l.producto)),
        t.lecturas.map((l) => l.galones),
      ],
    );
    await c.query('COMMIT');
    return { guardadas: r.rows.length, ids: r.rows.map((x) => x.toma_id) };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    siYaExiste(err, t.lecturas.length === 1 ? t.lecturas[0]!.producto : 'alguno de estos productos', t.fecha, t.hora);
  }
}

export interface CambioToma {
  fecha: string;
  hora: string;
  galones: number;
  observaciones?: string;
  usuario?: string;
}

/** Producto, fecha, hora y estado de una toma (se leen antes de cambiarla, para poder explicar un choque) */
async function leerToma(c: Cliente, tomaId: number) {
  const r = await c.query<{ producto: string; fecha: string; hora: string; anulada: boolean }>(
    `SELECT p.nombre AS producto, to_char(t.fecha_hora, 'YYYY-MM-DD') AS fecha, to_char(t.fecha_hora, 'HH24:MI') AS hora, t.anulada
       FROM dw.toma_fisica t JOIN dw.dim_producto p ON p.producto_key = t.producto_key
      WHERE t.toma_id = $1`,
    [tomaId],
  );
  return r.rows[0] ?? null;
}

/** Corrige la fecha, la hora, los galones o las observaciones de una toma vigente. El trigger anota qué cambió */
export async function editarToma(c: Cliente, tomaId: number, t: CambioToma) {
  await exigir(c, true);
  const actual = await leerToma(c, tomaId);
  if (!actual || actual.anulada) throw new ErrorToma(`La toma ${tomaId} no existe o está anulada (restáurala primero para editarla).`);
  try {
    const r = await c.query(
      `UPDATE dw.toma_fisica
          SET fecha_hora = $2::timestamp, galones = $3, observaciones = $4, modificada_en = now(), modificada_por = $5
        WHERE toma_id = $1 AND NOT anulada`,
      [tomaId, `${t.fecha} ${t.hora}:00`, t.galones, t.observaciones?.trim() || null, t.usuario?.trim() || null],
    );
    if (!r.rowCount) throw new ErrorToma(`La toma ${tomaId} se anuló mientras la editabas: restáurala primero.`);
    return { editada: tomaId };
  } catch (err) {
    if (err instanceof ErrorToma) throw err;
    siYaExiste(err, actual.producto, t.fecha, t.hora);
  }
}

export async function anularToma(c: Cliente, tomaId: number, usuario: string | undefined) {
  await exigir(c, false);
  const r = await c.query(`UPDATE dw.toma_fisica SET anulada = true, anulada_en = now(), anulada_por = $2 WHERE toma_id = $1 AND NOT anulada`, [
    tomaId,
    usuario?.trim() || null,
  ]);
  if (!r.rowCount) throw new ErrorToma(`La toma ${tomaId} no existe o ya estaba anulada.`);
  return { anulada: tomaId };
}

/** Vuelve a contar una toma anulada en el inventario (si no hay otra vigente del mismo producto a esa hora) */
export async function restaurarToma(c: Cliente, tomaId: number, usuario: string | undefined) {
  await exigir(c, true);
  const actual = await leerToma(c, tomaId);
  if (!actual || !actual.anulada) throw new ErrorToma(`La toma ${tomaId} no existe o no está anulada.`);
  try {
    const r = await c.query(
      `UPDATE dw.toma_fisica SET anulada = false, anulada_en = NULL, anulada_por = NULL, modificada_en = now(), modificada_por = $2
        WHERE toma_id = $1 AND anulada`,
      [tomaId, usuario?.trim() || null],
    );
    if (!r.rowCount) throw new ErrorToma(`La toma ${tomaId} ya se había restaurado.`);
    return { restaurada: tomaId };
  } catch (err) {
    if (err instanceof ErrorToma) throw err;
    siYaExiste(err, actual.producto, actual.fecha, actual.hora);
  }
}

export async function historialToma(c: Cliente, tomaId: number) {
  await exigir(c, true);
  const r = await c.query(
    `SELECT h.accion, h.campo, h.valor_anterior, h.valor_nuevo, h.usuario, h.en
       FROM dw.toma_fisica_historial h
      WHERE h.toma_id = $1
      ORDER BY h.historial_id`,
    [tomaId],
  );
  return r.rows;
}
