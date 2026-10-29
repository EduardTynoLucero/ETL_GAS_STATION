// Inventario de combustible: existencia inicial, compras, ventas y existencia final de un rango de fechas,
// y las tomas físicas que registra el usuario. La existencia en cualquier momento sale de la toma física
// más cercana (mart.existencia_en): la última hecha antes, o si no hay, la primera después.
import type { Cliente } from '../db.js';

export interface FiltrosInventario {
  estacion: string; // código, por ejemplo PCONC
  desde: string; // aaaa-mm-dd
  hasta: string;
}

const n = (sql: string, dec = 3) => `round((${sql})::numeric, ${dec})::float8`;

/** ¿Ya se ejecutó sql/actualizar_compras_inventario.sql? */
async function instalado(c: Cliente): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(
    `SELECT to_regclass('dw.fact_compra') IS NOT NULL AND to_regclass('dw.toma_fisica') IS NOT NULL
            AND to_regprocedure('mart.existencia_en(int, int, timestamp)') IS NOT NULL AS ok`,
  );
  return r.rows[0]!.ok;
}

export async function opcionesInventario(c: Cliente) {
  if (!(await instalado(c))) return { instalado: false as const };
  const estaciones = await c.query<{ codigo: string; nombre: string }>(
    `SELECT codigo, nombre FROM dw.dim_estacion WHERE estacion_key <> -1 ORDER BY codigo`,
  );
  const productos = await c.query<{ nombre: string }>(
    `SELECT nombre FROM dw.dim_producto WHERE familia = 'COMBUSTIBLE' ORDER BY producto_key`,
  );
  // De la primera a la última fecha con ventas, compras o tomas físicas
  const rango = await c.query<{ desde: string | null; hasta: string | null }>(
    `SELECT to_char(min(f), 'YYYY-MM-DD') AS desde, to_char(max(f), 'YYYY-MM-DD') AS hasta
       FROM (SELECT min(fecha_hora)::date AS f FROM dw.fact_despacho UNION ALL SELECT max(fecha_hora)::date FROM dw.fact_despacho
             UNION ALL SELECT min(fecha_hora)::date FROM dw.fact_compra UNION ALL SELECT max(fecha_hora)::date FROM dw.fact_compra
             UNION ALL SELECT min(fecha_hora)::date FROM dw.toma_fisica WHERE NOT anulada
             UNION ALL SELECT max(fecha_hora)::date FROM dw.toma_fisica WHERE NOT anulada) x`,
  );
  return {
    instalado: true as const,
    estaciones: estaciones.rows,
    productos: productos.rows.map((p) => p.nombre),
    rango: rango.rows[0] ?? { desde: null, hasta: null },
  };
}

/**
 * Movimiento de inventario de cada combustible en el rango [desde 00:00, hasta + 1 día 00:00):
 *  - inicial: existencia al empezar el día desde, desde la toma física más cercana
 *  - compras y ventas del rango (las compras anuladas no cuentan)
 *  - final teórico = inicial + compras - ventas
 *  - final según toma: existencia al terminar el día hasta, desde la toma más cercana a ese momento. Si
 *    hubo una toma dentro del rango, la diferencia con el teórico es el faltante (-) o sobrante (+)
 * Sin ninguna toma física del producto no se puede saber la existencia: inicial y final quedan en null.
 */
export async function inventario(c: Cliente, f: FiltrosInventario) {
  if (!(await instalado(c))) return { instalado: false as const };
  const est = await c.query<{ estacion_key: number; nombre: string }>(`SELECT estacion_key, nombre FROM dw.dim_estacion WHERE codigo = $1`, [f.estacion]);
  const estacion = est.rows[0];
  if (!estacion) return { instalado: true as const, estacion: null, productos: [], diario: [], tomas: [], compras: [] };
  const params = [estacion.estacion_key, f.desde, f.hasta];
  const DESDE = '$2::date::timestamp';
  const FIN = '($3::date + 1)::timestamp';

  const productos = await c.query(
    `WITH p AS (SELECT producto_key, nombre FROM dw.dim_producto WHERE familia = 'COMBUSTIBLE'),
     mov AS (
       SELECT p.producto_key,
              (SELECT coalesce(sum(k.cantidad), 0) FROM dw.fact_compra k
                WHERE k.estacion_key = $1 AND k.producto_key = p.producto_key AND NOT k.anulada
                  AND k.fecha_hora >= ${DESDE} AND k.fecha_hora < ${FIN}) AS compras,
              (SELECT count(*) FROM dw.fact_compra k
                WHERE k.estacion_key = $1 AND k.producto_key = p.producto_key AND NOT k.anulada
                  AND k.fecha_hora >= ${DESDE} AND k.fecha_hora < ${FIN}) AS facturas,
              (SELECT coalesce(sum(k.fob_total), 0) FROM dw.fact_compra k
                WHERE k.estacion_key = $1 AND k.producto_key = p.producto_key AND NOT k.anulada
                  AND k.fecha_hora >= ${DESDE} AND k.fecha_hora < ${FIN}) AS costo_compras,
              (SELECT coalesce(sum(v.cantidad_gal), 0) FROM dw.fact_despacho v
                WHERE v.estacion_key = $1 AND v.producto_key = p.producto_key
                  AND v.fecha_key BETWEEN to_char($2::date, 'YYYYMMDD')::int AND to_char($3::date, 'YYYYMMDD')::int) AS ventas,
              (SELECT coalesce(sum(v.monto_total), 0) FROM dw.fact_despacho v
                WHERE v.estacion_key = $1 AND v.producto_key = p.producto_key
                  AND v.fecha_key BETWEEN to_char($2::date, 'YYYYMMDD')::int AND to_char($3::date, 'YYYYMMDD')::int) AS venta_monto
         FROM p
     )
     SELECT p.nombre AS producto,
            ${n('i.galones')} AS inicial,
            to_char(i.toma_fecha_hora, 'YYYY-MM-DD HH24:MI') AS inicial_toma_en,
            ${n('i.toma_galones')} AS inicial_toma_galones,
            ${n('m.compras')} AS compras,
            m.facturas::int AS facturas,
            ${n('m.costo_compras', 2)} AS costo_compras,
            ${n('m.ventas')} AS ventas,
            ${n('m.venta_monto', 2)} AS venta_monto,
            ${n('i.galones + m.compras - m.ventas')} AS final_teorico,
            ${n('x.galones')} AS final_segun_toma,
            to_char(x.toma_fecha_hora, 'YYYY-MM-DD HH24:MI') AS final_toma_en,
            (SELECT count(*)::int FROM dw.toma_fisica t
              WHERE t.estacion_key = $1 AND t.producto_key = p.producto_key AND NOT t.anulada
                AND t.fecha_hora >= ${DESDE} AND t.fecha_hora < ${FIN}) AS tomas_en_rango
       FROM p
       JOIN mov m ON m.producto_key = p.producto_key
       LEFT JOIN LATERAL mart.existencia_en($1, p.producto_key, ${DESDE}) i ON true
       LEFT JOIN LATERAL mart.existencia_en($1, p.producto_key, ${FIN}) x ON true
      ORDER BY p.producto_key`,
    params,
  );

  // Compras y ventas de cada día; la existencia al cierre de cada día se calcula en el panel desde la inicial
  const diario = await c.query(
    `WITH p AS (SELECT producto_key, nombre FROM dw.dim_producto WHERE familia = 'COMBUSTIBLE'),
     dias AS (SELECT d::date AS fecha FROM generate_series($2::date, $3::date, interval '1 day') AS d),
     k AS (SELECT producto_key, fecha_hora::date AS fecha, sum(cantidad) AS galones
             FROM dw.fact_compra
            WHERE estacion_key = $1 AND NOT anulada AND fecha_hora >= ${DESDE} AND fecha_hora < ${FIN}
            GROUP BY 1, 2),
     v AS (SELECT producto_key, fecha_hora::date AS fecha, sum(cantidad_gal) AS galones
             FROM dw.fact_despacho
            WHERE estacion_key = $1
              AND fecha_key BETWEEN to_char($2::date, 'YYYYMMDD')::int AND to_char($3::date, 'YYYYMMDD')::int
            GROUP BY 1, 2)
     SELECT to_char(d.fecha, 'YYYY-MM-DD') AS fecha, p.nombre AS producto,
            ${n('coalesce(k.galones, 0)')} AS compras,
            ${n('coalesce(v.galones, 0)')} AS ventas
       FROM dias d CROSS JOIN p
       LEFT JOIN k ON k.producto_key = p.producto_key AND k.fecha = d.fecha
       LEFT JOIN v ON v.producto_key = p.producto_key AND v.fecha = d.fecha
      ORDER BY d.fecha, p.producto_key`,
    params,
  );

  // Tomas físicas del rango, contra lo que debía haber según la existencia inicial y los movimientos
  const tomas = await c.query(
    `SELECT t.toma_id, p.nombre AS producto, to_char(t.fecha_hora, 'YYYY-MM-DD HH24:MI') AS fecha_hora,
            ${n('t.galones')} AS galones,
            ${n('i.galones + mart.movimiento_neto($1, t.producto_key, $2::date::timestamp, t.fecha_hora)')} AS teorico,
            ${n('t.galones - (i.galones + mart.movimiento_neto($1, t.producto_key, $2::date::timestamp, t.fecha_hora))')} AS diferencia,
            t.usuario, t.observaciones, t.registrada_en
       FROM dw.toma_fisica t
       JOIN dw.dim_producto p ON p.producto_key = t.producto_key
       LEFT JOIN LATERAL mart.existencia_en($1, t.producto_key, ${DESDE}) i ON true
      WHERE t.estacion_key = $1 AND NOT t.anulada AND t.fecha_hora >= ${DESDE} AND t.fecha_hora < ${FIN}
      ORDER BY t.fecha_hora, p.producto_key`,
    params,
  );

  const compras = await c.query(
    `SELECT to_char(k.fecha_hora, 'YYYY-MM-DD HH24:MI') AS fecha_hora, k.factura_serie || '-' || k.factura_numero AS factura,
            k.turno, p.nombre AS producto, pr.nombre AS proveedor,
            ${n('k.cantidad')} AS galones, ${n('k.precio_unitario', 4)} AS precio, ${n('k.monto_total', 2)} AS total,
            ${n('k.fob_total', 2)} AS costo, ${n('k.fob_total / nullif(k.cantidad, 0)', 4)} AS costo_por_galon
       FROM dw.fact_compra k
       JOIN dw.dim_producto p   ON p.producto_key = k.producto_key
       JOIN dw.dim_proveedor pr ON pr.proveedor_key = k.proveedor_key
      WHERE k.estacion_key = $1 AND NOT k.anulada AND p.familia = 'COMBUSTIBLE'
        AND k.fecha_hora >= ${DESDE} AND k.fecha_hora < ${FIN}
      ORDER BY k.fecha_hora, p.producto_key`,
    params,
  );

  return {
    instalado: true as const,
    estacion: { codigo: f.estacion, nombre: estacion.nombre },
    filtros: f,
    productos: productos.rows,
    diario: diario.rows,
    tomas: tomas.rows,
    compras: compras.rows,
  };
}
