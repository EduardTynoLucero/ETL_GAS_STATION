// Consultas del dashboard sobre el modelo (mart y dw). Todas reciben los mismos filtros:
// rango de fechas, estación y producto.
import type { Cliente } from '../db.js';

export interface Filtros {
  desde?: string; // aaaa-mm-dd
  hasta?: string;
  estacion?: string; // código, por ejemplo PCONC
  producto?: string; // nombre de dim_producto, por ejemplo SUPER
}

/** Arma el WHERE con parámetros numerados; las columnas cambian según la consulta */
function donde(f: Filtros, col: { fecha: string; estacion: string; producto?: string }, params: unknown[] = []) {
  const cond: string[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  if (f.desde) cond.push(`${col.fecha} >= ${p(f.desde)}::date`);
  if (f.hasta) cond.push(`${col.fecha} <= ${p(f.hasta)}::date`);
  if (f.estacion) cond.push(`${col.estacion} = ${p(f.estacion)}`);
  if (f.producto && col.producto) cond.push(`${col.producto} = ${p(f.producto)}`);
  return { sql: cond.length ? `WHERE ${cond.join(' AND ')}` : '', params };
}

const DIARIO = `mart.mv_ventas_diarias v
  JOIN dw.dim_fecha d    ON d.fecha_key = v.fecha_key
  JOIN dw.dim_estacion e ON e.estacion_key = v.estacion_key
  JOIN dw.dim_producto p ON p.producto_key = v.producto_key`;
const COL_DIARIO = { fecha: 'd.fecha', estacion: 'e.codigo', producto: 'p.nombre' };

const HECHO = `dw.fact_despacho f
  JOIN dw.dim_fecha d    ON d.fecha_key = f.fecha_key
  JOIN dw.dim_estacion e ON e.estacion_key = f.estacion_key
  JOIN dw.dim_producto p ON p.producto_key = f.producto_key`;

const n = (sql: string, dec = 2) => `round(coalesce(${sql}, 0)::numeric, ${dec})::float8`;

/** Fecha aaaa-mm-dd como fecha_key (aaaammdd) */
const claveFecha = (t: string) => Number(t.replaceAll('-', ''));

// Cada medida de control, sumada ticket por ticket en el hecho y por grupo en mart.mv_ventas_diarias. Además
// de los totales van el costo, la utilidad y los descuentos, y sumas de control por posición (la fecha, la
// estación y el producto multiplicados por el monto y por los tickets): una carga que solo corrige costos o
// mueve tickets de un día o de un producto a otro no cambia los totales, pero sí estas sumas.
const CONTROL_VISTAS: [hecho: string, mart: string][] = [
  ['count(*)', 'sum(v.tickets)'],
  ['sum(f.monto_total)', 'sum(v.monto_total)'],
  ['sum(f.cantidad_gal)', 'sum(v.galones)'],
  ['sum(f.monto_neto)', 'sum(v.monto_neto)'],
  ['sum(f.iva)', 'sum(v.iva)'],
  ['sum(f.idp)', 'sum(v.idp)'],
  ['sum(f.costo_total)', 'sum(v.costo_total)'],
  ['sum(f.utilidad)', 'sum(v.utilidad)'],
  ['sum(f.descuento_pricebook)', 'sum(v.descuento_pricebook)'],
  ['count(*) FILTER (WHERE tv.con_factura)', 'sum(v.tickets) FILTER (WHERE v.con_factura)'],
  ['count(*) FILTER (WHERE cl.es_consumidor_final)', 'sum(v.tickets) FILTER (WHERE v.es_consumidor_final)'],
  ['sum(f.fecha_key::numeric * f.monto_total)', 'sum(v.fecha_key::numeric * v.monto_total)'],
  ['sum(f.fecha_key::numeric)', 'sum(v.fecha_key::numeric * v.tickets)'],
  ['sum(f.estacion_key::numeric * f.monto_total)', 'sum(v.estacion_key::numeric * v.monto_total)'],
  ['sum(f.producto_key::numeric * f.monto_total)', 'sum(v.producto_key::numeric * v.monto_total)'],
  ['sum(f.producto_key::numeric)', 'sum(v.producto_key::numeric * v.tickets)'],
];

/**
 * Las vistas materializadas de mart se refrescan al final de cada carga. Si ese paso falló (por ejemplo,
 * se cortó la conexión justo después de publicar), quedan atrasadas respecto de dw.fact_despacho y el
 * dashboard mezclaría números viejos (indicadores, ventas por día) con nuevos (mapa de calor, clientes).
 * Se comparan las sumas de control de las dos y, si no cuadran, se intenta refrescar aquí mismo.
 */
async function revisarVistas(c: Cliente): Promise<{ atrasadas: boolean; aviso: string | null }> {
  const columnas = (lado: 0 | 1) => CONTROL_VISTAS.map((par, i) => `coalesce(${par[lado]}, 0) AS c${i}`).join(', ');
  const r = await c.query<{ al_dia: boolean }>(
    `SELECT ${CONTROL_VISTAS.map((_, i) => `h.c${i} = m.c${i}`).join(' AND ')} AS al_dia
       FROM (SELECT ${columnas(0)}
               FROM dw.fact_despacho f
               JOIN dw.dim_tipo_venta tv ON tv.tipo_venta_key = f.tipo_venta_key
               JOIN dw.dim_cliente cl    ON cl.cliente_key = f.cliente_key) h,
            (SELECT ${columnas(1)} FROM mart.mv_ventas_diarias v) m`,
  );
  if (r.rows[0]?.al_dia !== false) return { atrasadas: false, aviso: null };
  try {
    await c.query('CALL mart.refrescar()');
    return { atrasadas: false, aviso: null };
  } catch (err) {
    return { atrasadas: true, aviso: (err as Error).message };
  }
}

export async function opciones(c: Cliente) {
  // Primero las vistas: el rango, las estaciones y los productos salen de ellas
  const vistas = await revisarVistas(c);
  const r = await c.query<{ desde: string | null; hasta: string | null }>(
    `SELECT to_char(min(d.fecha), 'YYYY-MM-DD') AS desde, to_char(max(d.fecha), 'YYYY-MM-DD') AS hasta
       FROM mart.mv_ventas_diarias v JOIN dw.dim_fecha d ON d.fecha_key = v.fecha_key`,
  );
  const estaciones = await c.query<{ codigo: string; nombre: string }>(
    `SELECT e.codigo, e.nombre FROM dw.dim_estacion e
      WHERE e.estacion_key IN (SELECT DISTINCT estacion_key FROM mart.mv_ventas_diarias) ORDER BY e.codigo`,
  );
  const productos = await c.query<{ nombre: string }>(
    `SELECT p.nombre FROM dw.dim_producto p
      WHERE p.producto_key IN (SELECT DISTINCT producto_key FROM mart.mv_ventas_diarias)
      ORDER BY p.producto_key = -1, p.producto_key`,
  );
  const carga = await c.query<{ ultima: number | null }>(`SELECT max(carga_id) AS ultima FROM etl.carga WHERE estado = 'CARGADO'`);
  return {
    rango: r.rows[0] ?? { desde: null, hasta: null },
    estaciones: estaciones.rows,
    productos: productos.rows.map((x) => x.nombre),
    // Cambia con cada carga publicada (desde el panel o la consola): así el dashboard sabe que debe volver a consultar
    ultimaCarga: carga.rows[0]?.ultima ?? null,
    vistasAtrasadas: vistas.atrasadas,
    avisoVistas: vistas.aviso,
  };
}

async function kpis(c: Cliente, f: Filtros) {
  const w = donde(f, COL_DIARIO);
  // Descuentos y recargos de pricebook por separado: un recargo no es un descuento negativo
  const r = await c.query(
    `SELECT coalesce(sum(v.tickets), 0)::int AS tickets,
            ${n('sum(v.galones)', 3)} AS galones,
            ${n('sum(v.monto_total)')} AS venta,
            ${n('sum(v.monto_neto)')} AS neto,
            ${n('sum(v.iva)')} AS iva,
            ${n('sum(v.idp)')} AS idp,
            ${n('sum(v.costo_total)')} AS costo,
            ${n('sum(v.utilidad)')} AS utilidad,
            ${n('sum(v.descuento_pricebook) FILTER (WHERE v.descuento_pricebook > 0)')} AS descuento_pricebook,
            ${n('-sum(v.descuento_pricebook) FILTER (WHERE v.descuento_pricebook < 0)')} AS recargo_pricebook,
            ${n('sum(v.monto_total) FILTER (WHERE NOT v.con_factura)')} AS venta_sin_factura,
            coalesce(sum(v.tickets) FILTER (WHERE NOT v.con_factura), 0)::int AS tickets_sin_factura,
            ${n('sum(v.monto_total) FILTER (WHERE v.es_consumidor_final)')} AS venta_consumidor_final,
            count(DISTINCT v.fecha_key)::int AS dias
       FROM ${DIARIO} ${w.sql}`,
    w.params,
  );
  return r.rows[0];
}

/** Mismo número de días justo antes del rango elegido, para comparar */
function periodoAnterior(f: Filtros): (Filtros & { desde: string; hasta: string }) | null {
  if (!f.desde || !f.hasta) return null;
  const desde = new Date(`${f.desde}T00:00:00Z`);
  const hasta = new Date(`${f.hasta}T00:00:00Z`);
  const dias = Math.round((hasta.getTime() - desde.getTime()) / 86400000) + 1;
  if (dias < 1) return null;
  const fin = new Date(desde.getTime() - 86400000);
  const inicio = new Date(fin.getTime() - (dias - 1) * 86400000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { ...f, desde: iso(inicio), hasta: iso(fin) };
}

/**
 * Solo se compara lo comparable. Los dos periodos tienen que tener los mismos días cargados: cada estación
 * con ventas en los mismos días, contados desde el inicio de cada periodo (sin el filtro de producto, porque
 * lo que se revisa es qué se cargó). Así no se compara contra un periodo anterior que empieza antes de los
 * datos, ni un periodo actual al que le faltan días (una semana sin cargar, una estación cuya última
 * exportación es más vieja): los dos casos darían subidas o caídas falsas. Si no coinciden se devuelve
 * anterior = null y el motivo.
 *
 * El último día cargado de una estación suele quedar a medias (se exporta a media jornada). Si el periodo
 * termina en ese día y su último ticket es de antes de las 23:00, el último día del periodo anterior se
 * cuenta solo hasta esa misma hora, para comparar las mismas horas. Desde las 23:00 el día se da por
 * completo: falta menos de una hora, casi siempre sin ventas. cortes dice la hora de cada estación, solo
 * cuando el corte dejó fuera algún ticket del periodo anterior (si no, no cambió nada).
 */
async function compararConAnterior(c: Cliente, f: Filtros) {
  const periodo = periodoAnterior(f);
  if (!periodo) return { anterior: null, motivo: null };
  const w = donde({ estacion: f.estacion, producto: f.producto }, COL_DIARIO);
  const r = await c.query<{ primera: string | null }>(`SELECT to_char(min(d.fecha), 'YYYY-MM-DD') AS primera FROM ${DIARIO} ${w.sql}`, w.params);
  const primera = r.rows[0]?.primera;
  if (!primera || periodo.hasta < primera) return { anterior: null, motivo: 'sin-datos' as const };
  if (periodo.desde < primera) return { anterior: null, motivo: 'parcial' as const };

  // Días con ventas de cada estación en un periodo, como distancia al primer día del periodo
  const pd: unknown[] = [];
  const p = (v: unknown) => (pd.push(v), `$${pd.length}`);
  const deLaEstacion = f.estacion ? `AND e.codigo = ${p(f.estacion)}` : '';
  const diasCargados = (desde: string, hasta: string) => {
    const inicio = p(desde);
    return `SELECT DISTINCT v.estacion_key, d.fecha - ${inicio}::date AS k FROM ${DIARIO}
             WHERE d.fecha BETWEEN ${inicio}::date AND ${p(hasta)}::date ${deLaEstacion}`;
  };
  const distintos = await c.query<{ dias: number }>(
    `SELECT count(*)::int AS dias
       FROM (${diasCargados(f.desde!, f.hasta!)}) a
       FULL JOIN (${diasCargados(periodo.desde, periodo.hasta)}) b ON b.estacion_key = a.estacion_key AND b.k = a.k
      WHERE a.k IS NULL OR b.k IS NULL`,
    pd,
  );
  if (distintos.rows[0]!.dias > 0) return { anterior: null, motivo: 'parcial' as const };

  // Indicadores del periodo anterior desde los tickets, con el último día cortado a la hora del último
  // ticket del periodo actual en las estaciones cuyo último día cargado es el último del periodo
  const wa = donde(periodo, COL_DIARIO);
  const ultimo = `$${wa.params.push(claveFecha(f.hasta!))}`;
  const ultimoAnterior = `$${wa.params.push(claveFecha(periodo.hasta))}`;
  const a = await c.query<{ tickets: number; galones: number; venta: number; cortes: { estacion: string; hora: string }[] }>(
    `WITH corte AS (
       SELECT f.estacion_key, max(f.fecha_hora)::time AS hora
         FROM dw.fact_despacho f
        WHERE f.fecha_key = ${ultimo}
          AND NOT EXISTS (SELECT 1 FROM dw.fact_despacho g WHERE g.estacion_key = f.estacion_key AND g.fecha_key > ${ultimo})
        GROUP BY f.estacion_key
       HAVING max(f.fecha_hora)::time < '23:00'
     ), x AS (
       SELECT f.cantidad_gal, f.monto_total, e.codigo, k.hora,
              coalesce(f.fecha_key = ${ultimoAnterior} AND f.fecha_hora::time > k.hora, false) AS fuera
         FROM ${HECHO}
         LEFT JOIN corte k ON k.estacion_key = f.estacion_key
         ${wa.sql}
     )
     SELECT count(*) FILTER (WHERE NOT x.fuera)::int AS tickets,
            ${n('sum(x.cantidad_gal) FILTER (WHERE NOT x.fuera)', 3)} AS galones,
            ${n('sum(x.monto_total) FILTER (WHERE NOT x.fuera)')} AS venta,
            (SELECT coalesce(jsonb_agg(jsonb_build_object('estacion', s.codigo, 'hora', s.hora) ORDER BY s.codigo), '[]')
               FROM (SELECT DISTINCT codigo, to_char(hora, 'HH24:MI') AS hora FROM x WHERE fuera) s) AS cortes
       FROM x`,
    wa.params,
  );
  const { cortes, ...kpisAnterior } = a.rows[0]!;
  if (!kpisAnterior.tickets) return { anterior: null, motivo: 'sin-datos' as const };
  // Solo las medidas que se comparan, todas con el mismo corte
  return { anterior: { filtros: periodo, kpis: kpisAnterior, cortes }, motivo: null };
}

async function diario(c: Cliente, f: Filtros) {
  const w = donde(f, COL_DIARIO);
  const r = await c.query(
    `SELECT to_char(d.fecha, 'YYYY-MM-DD') AS fecha, p.nombre AS producto,
            sum(v.tickets)::int AS tickets,
            ${n('sum(v.galones)', 3)} AS galones,
            ${n('sum(v.monto_total)')} AS venta,
            ${n('sum(v.utilidad)')} AS utilidad,
            ${n('sum(v.monto_total) FILTER (WHERE NOT v.con_factura)')} AS venta_sin_factura,
            ${n('sum(v.utilidad) / nullif(sum(v.galones), 0)', 4)} AS utilidad_por_galon,
            ${n('sum(v.monto_total) / nullif(sum(v.galones), 0)', 4)} AS precio_por_galon,
            ${n('sum(v.costo_total) / nullif(sum(v.galones), 0)', 4)} AS costo_por_galon
       FROM ${DIARIO} ${w.sql}
      GROUP BY d.fecha, p.nombre, p.producto_key
      ORDER BY d.fecha, p.producto_key`,
    w.params,
  );
  return r.rows;
}

async function porProducto(c: Cliente, f: Filtros) {
  const w = donde(f, COL_DIARIO);
  const r = await c.query(
    `SELECT p.nombre AS producto,
            sum(v.tickets)::int AS tickets,
            ${n('sum(v.galones)', 3)} AS galones,
            ${n('sum(v.monto_total)')} AS venta,
            ${n('sum(v.monto_neto)')} AS neto,
            ${n('sum(v.costo_total)')} AS costo,
            ${n('sum(v.utilidad)')} AS utilidad,
            ${n('100 * sum(v.utilidad) / nullif(sum(v.monto_neto), 0)', 1)} AS margen_pct,
            ${n('sum(v.utilidad) / nullif(sum(v.galones), 0)', 4)} AS utilidad_por_galon,
            ${n('sum(v.monto_total) FILTER (WHERE NOT v.con_factura)')} AS venta_sin_factura,
            ${n('sum(v.descuento_pricebook) FILTER (WHERE v.descuento_pricebook > 0)')} AS descuento_pricebook,
            ${n('-sum(v.descuento_pricebook) FILTER (WHERE v.descuento_pricebook < 0)')} AS recargo_pricebook
       FROM ${DIARIO} ${w.sql}
      GROUP BY p.nombre, p.producto_key
      ORDER BY p.producto_key = -1, p.producto_key`,
    w.params,
  );
  return r.rows;
}

async function pricebooks(c: Cliente, f: Filtros) {
  const w = donde(f, COL_DIARIO);
  const r = await c.query(
    `SELECT v.tipo_pricebook AS tipo, sum(v.tickets)::int AS tickets,
            ${n('sum(v.galones)', 3)} AS galones,
            ${n('sum(v.monto_total)')} AS venta,
            ${n('sum(v.descuento_pricebook) FILTER (WHERE v.descuento_pricebook > 0)')} AS descuento,
            ${n('-sum(v.descuento_pricebook) FILTER (WHERE v.descuento_pricebook < 0)')} AS recargo
       FROM ${DIARIO} ${w.sql}
      GROUP BY v.tipo_pricebook ORDER BY sum(v.tickets) DESC`,
    w.params,
  );
  return r.rows;
}

/**
 * Venta por estación, turno y producto, con el mismo filtro por fecha del ticket que los indicadores, para
 * que los totales cuadren. Un turno que cruza la medianoche puede quedar solo en parte dentro del rango:
 * tickets_turno dice cuántos tickets tiene en total (con el mismo filtro de producto). La fecha operativa
 * y el horario del turno van como contexto para el tooltip.
 */
async function turnos(c: Cliente, f: Filtros) {
  const w = donde(f, COL_DIARIO);
  const delProducto = f.producto ? `AND p.nombre = $${w.params.push(f.producto)}` : '';
  const r = await c.query(
    `WITH x AS (
       SELECT f.estacion_key, f.turno_key, f.producto_key, count(*) AS tickets,
              sum(f.cantidad_gal) AS galones, sum(f.monto_total) AS venta, sum(f.utilidad) AS utilidad,
              sum(f.monto_total) FILTER (WHERE f.factura_numero IS NULL) AS venta_sin_factura
         FROM ${HECHO} ${w.sql}
        GROUP BY 1, 2, 3
     ), total AS (
       SELECT f.turno_key, count(*) AS tickets
         FROM dw.fact_despacho f JOIN dw.dim_producto p ON p.producto_key = f.producto_key
        WHERE f.turno_key IN (SELECT turno_key FROM x) ${delProducto}
        GROUP BY 1
     )
     SELECT t.numero AS turno, e.codigo AS estacion, p.nombre AS producto,
            to_char(t.fecha_operativa, 'YYYY-MM-DD') AS fecha_operativa,
            to_char(t.primer_ticket_en, 'YYYY-MM-DD HH24:MI') AS desde,
            to_char(t.ultimo_ticket_en, 'YYYY-MM-DD HH24:MI') AS hasta,
            x.tickets::int AS tickets,
            ${n('x.galones', 3)} AS galones,
            ${n('x.venta')} AS venta,
            ${n('x.utilidad')} AS utilidad,
            ${n('x.venta_sin_factura')} AS venta_sin_factura,
            tot.tickets::int AS tickets_turno
       FROM x
       JOIN total tot         ON tot.turno_key = x.turno_key
       JOIN dw.dim_turno t    ON t.turno_key = x.turno_key
       JOIN dw.dim_estacion e ON e.estacion_key = x.estacion_key
       JOIN dw.dim_producto p ON p.producto_key = x.producto_key
      ORDER BY e.codigo, t.numero, p.producto_key`,
    w.params,
  );
  return r.rows;
}

/**
 * Promedio por día de cada día de la semana y hora. En un rango cualquiera unos días de la semana caen
 * más veces que otros (del 30 sep al 23 oct, el jueves 4 veces y el sábado 3): sumar totales los pondría
 * por delante sin vender más. Cada celda se divide entre las fechas de ese día de la semana con ventas en
 * el rango (contadas con el rango y la estación, sin el producto) cuyos datos cargados cubren esa hora
 * (dias), para que un día cargado a medias no baje los promedios de las horas que no trae.
 * Solo el primer y el último día cargados de cada estación pueden quedar a medias (la exportación empezó o
 * terminó a media jornada): esos cubren desde la hora de su primer ticket hasta la del último. Los demás
 * cubren las 24 horas aunque de madrugada no haya ventas; si no, una venta suelta a la 01:00 se dividiría
 * entre un solo día. Con varias estaciones, una fecha cubre las horas que cubren todas las que vendieron.
 */
async function mapaDeCalor(c: Cliente, f: Filtros) {
  const w = donde(f, COL_DIARIO);
  const wd = donde({ desde: f.desde, hasta: f.hasta, estacion: f.estacion }, COL_DIARIO, w.params);
  const hora = 'extract(hour FROM f.fecha_hora)::int';
  const r = await c.query(
    `WITH limites AS (
       SELECT estacion_key, min(fecha_key) AS primera, max(fecha_key) AS ultima FROM dw.fact_despacho GROUP BY 1
     ), cubre AS (
       SELECT x.fecha_key, x.dia, max(x.desde) AS desde, min(x.hasta) AS hasta
         FROM (SELECT f.fecha_key, d.dia_semana::int AS dia,
                      CASE WHEN f.fecha_key = l.primera THEN min(${hora}) ELSE 0 END AS desde,
                      CASE WHEN f.fecha_key = l.ultima THEN max(${hora}) ELSE 23 END AS hasta
                 FROM ${HECHO}
                 JOIN limites l ON l.estacion_key = f.estacion_key
                 ${wd.sql}
                GROUP BY f.estacion_key, f.fecha_key, d.dia_semana, l.primera, l.ultima) x
        GROUP BY x.fecha_key, x.dia
     ), dias AS (
       SELECT x.dia, h.hora, count(*)::int AS dias
         FROM cubre x CROSS JOIN generate_series(x.desde, x.hasta) AS h(hora)
        GROUP BY 1, 2
     )
     SELECT d.dia_semana::int AS dia, ${hora} AS hora, x.dias,
            ${n('count(*)::numeric / x.dias')} AS tickets,
            ${n('sum(f.monto_total) / x.dias')} AS venta,
            ${n('sum(f.cantidad_gal) / x.dias', 3)} AS galones
       FROM ${HECHO}
       JOIN cubre k ON k.fecha_key = f.fecha_key AND ${hora} BETWEEN k.desde AND k.hasta
       JOIN dias x  ON x.dia = d.dia_semana AND x.hora = ${hora}
       ${w.sql}
      GROUP BY 1, 2, 3 ORDER BY 1, 2`,
    w.params,
  );
  return r.rows;
}

async function facturacion(c: Cliente, f: Filtros) {
  const w = donde(f, { fecha: 'fecha', estacion: 'estacion', producto: 'producto' });
  const r = await c.query(
    `SELECT tipo_facturacion AS tipo, count(*)::int AS tickets, ${n('sum(monto_total)')} AS venta
       FROM mart.v_despacho ${w.sql}
      GROUP BY tipo_facturacion ORDER BY tipo_facturacion`,
    w.params,
  );
  return r.rows;
}

/**
 * Top 10 por código de cliente. Un cliente puede tener varias versiones en dim_cliente (cambio de NIT):
 * se agrupa solo por el código y se muestran el nombre y el NIT de la versión vigente.
 */
async function clientes(c: Cliente, f: Filtros) {
  const w = donde(f, COL_DIARIO);
  const r = await c.query(
    `SELECT x.codigo, coalesce(a.nombre, x.nombre) AS nombre, coalesce(a.nit, x.nit) AS nit,
            x.tickets, ${n('x.galones', 3)} AS galones, ${n('x.venta')} AS venta,
            ${n('x.venta_sin_factura')} AS venta_sin_factura,
            ${n('x.descuento')} AS descuento, ${n('x.recargo')} AS recargo
       FROM (SELECT cl.codigo, max(cl.nombre) AS nombre, max(cl.nit) AS nit, count(*)::int AS tickets,
                    sum(f.cantidad_gal) AS galones, sum(f.monto_total) AS venta,
                    sum(f.monto_total) FILTER (WHERE f.factura_numero IS NULL) AS venta_sin_factura,
                    sum(f.descuento_pricebook) FILTER (WHERE f.descuento_pricebook > 0) AS descuento,
                    -sum(f.descuento_pricebook) FILTER (WHERE f.descuento_pricebook < 0) AS recargo
               FROM ${HECHO}
               JOIN dw.dim_cliente cl ON cl.cliente_key = f.cliente_key
               ${w.sql ? `${w.sql} AND` : 'WHERE'} NOT cl.es_consumidor_final AND cl.codigo <> 'N/D'
              GROUP BY cl.codigo
              ORDER BY sum(f.monto_total) DESC, cl.codigo
              LIMIT 10) x
       LEFT JOIN dw.dim_cliente a ON a.codigo = x.codigo AND a.es_actual
      ORDER BY x.venta DESC, x.codigo`,
    w.params,
  );
  return r.rows;
}

async function alertas(c: Cliente, f: Filtros) {
  // Las alertas no traen producto: el filtro de producto no aplica aquí
  const w = donde(f, { fecha: 'a.fecha_hora::date', estacion: 'a.estacion' });
  const resumen = await c.query(
    `SELECT a.alerta, count(*)::int AS tickets, ${n('sum(a.monto_total)')} AS monto
       FROM mart.v_alertas_ticket a ${w.sql}
      GROUP BY a.alerta ORDER BY count(*) DESC`,
    w.params,
  );
  const recientes = await c.query(
    `SELECT a.estacion, a.ticket_numero AS ticket, to_char(a.fecha_hora, 'YYYY-MM-DD HH24:MI') AS fecha_hora,
            a.alerta, a.detalle, ${n('a.monto_total')} AS monto
       FROM mart.v_alertas_ticket a ${w.sql}
      ORDER BY a.fecha_hora DESC, a.ticket_numero DESC
      LIMIT 100`,
    w.params,
  );
  return { resumen: resumen.rows, recientes: recientes.rows };
}

async function faltantes(c: Cliente, f: Filtros) {
  const w = donde(f, { fecha: 'x.ultimo_antes::date', estacion: 'x.estacion' });
  const r = await c.query(
    `SELECT x.estacion, x.falta_desde, x.falta_hasta, x.tickets_faltantes::int AS tickets_faltantes,
            to_char(x.ultimo_antes, 'YYYY-MM-DD HH24:MI') AS ultimo_antes,
            to_char(x.primero_despues, 'YYYY-MM-DD HH24:MI') AS primero_despues, x.turno
       FROM mart.v_tickets_faltantes x ${w.sql}
      ORDER BY x.falta_desde
      LIMIT 200`,
    w.params,
  );
  return r.rows;
}

export async function dashboard(c: Cliente, f: Filtros) {
  const k = await kpis(c, f);
  const comparacion = await compararConAnterior(c, f);
  return {
    filtros: f,
    kpis: k,
    anterior: comparacion.anterior,
    // Por qué no hay comparación: 'sin-datos' (el periodo anterior no está cargado) o 'parcial' (los dos
    // periodos no tienen los mismos días cargados)
    sinComparar: comparacion.motivo,
    diario: await diario(c, f),
    productos: await porProducto(c, f),
    pricebooks: await pricebooks(c, f),
    turnos: await turnos(c, f),
    mapaDeCalor: await mapaDeCalor(c, f),
    facturacion: await facturacion(c, f),
    clientes: await clientes(c, f),
    alertas: await alertas(c, f),
    faltantes: await faltantes(c, f),
  };
}

// ---------------------------------------------------------------------------------------------
// Historial de cargas

// etl.v_cargas es de la versión 1.0.0 y no trae el tipo de reporte: se toma de etl.carga
const COLUMNAS_CARGA = `v.carga_id, v.iniciado_en, k.tipo_reporte,
            v.archivo_nombre, v.usuario, v.estado, v.estacion_codigo, v.turno_min, v.turno_max,
            to_char(v.fecha_min, 'YYYY-MM-DD HH24:MI') AS fecha_min, to_char(v.fecha_max, 'YYYY-MM-DD HH24:MI') AS fecha_max,
            v.filas_detalle, v.insertadas, v.actualizadas, v.sin_cambio, v.errores::int AS errores, v.advertencias::int AS advertencias,
            v.cuadra, v.segundos::float8 AS segundos, v.mensaje
       FROM etl.v_cargas v JOIN etl.carga k ON k.carga_id = v.carga_id`;

export async function listaCargas(c: Cliente) {
  const r = await c.query(`SELECT ${COLUMNAS_CARGA} ORDER BY v.carga_id DESC LIMIT 100`);
  return r.rows;
}

export async function detalleCarga(c: Cliente, cargaId: number) {
  const carga = await c.query(`SELECT ${COLUMNAS_CARGA} WHERE v.carga_id = $1`, [cargaId]);
  if (!carga.rows[0]) return null;
  const incidencias = await c.query(
    `SELECT severidad, regla, count(*)::int AS cantidad,
            (array_agg(mensaje ORDER BY incidencia_id))[1:5] AS ejemplos
       FROM etl.incidencia WHERE carga_id = $1
      GROUP BY severidad, regla
      ORDER BY CASE severidad WHEN 'ERROR' THEN 0 WHEN 'ADVERTENCIA' THEN 1 ELSE 2 END, count(*) DESC`,
    [cargaId],
  );
  const cuadre = await c.query(
    `SELECT grupo, medida, tickets, suma_detalle::text AS suma, valor_reporte::text AS reporte, cuadra
       FROM etl.cuadre WHERE carga_id = $1 ORDER BY grupo = 'TOTAL GENERAL', grupo, medida`,
    [cargaId],
  );
  const cambios = await c.query(
    `SELECT entidad, campo, count(*)::int AS cantidad FROM etl.cambio WHERE carga_id = $1
      GROUP BY entidad, campo ORDER BY count(*) DESC`,
    [cargaId],
  );
  return { carga: carga.rows[0], incidencias: incidencias.rows, cuadre: cuadre.rows, cambios: cambios.rows };
}
