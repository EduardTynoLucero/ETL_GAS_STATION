// Vista previa de un Reporte de compras: lo que trae el archivo y qué pasaría en la base al cargarlo.
// Son pocas líneas (una por factura y producto), así que van todas en la respuesta, sin paginar.
import { Decimal } from 'decimal.js';
import { ErrorConfiguracion } from '../config.js';
import { conCliente } from '../db.js';
import { numeroStaging, tablasDeComprasInstaladas, ErrorSinTablasCompras } from '../carga/compras.js';
import { buscarCargaDelMismoArchivo } from '../carga/registro.js';
import { esCombustible } from '../reportes/compras/index.js';
import { codigoEstacion } from '../reportes/consulta-tickets/reglas.js';
import type { Severidad } from '../reportes/consulta-tickets/tipos.js';
import { agruparIncidencias, contarIncidencias } from './incidencias.js';
import type { EntradaCompras } from './vistaPrevia.js';

type EstadoEnBase = 'NUEVO' | 'IGUAL' | 'CAMBIA';

export interface ComparacionCompras {
  yaCargado: { cargaId: number; archivo: string; cuando: string } | null;
  nuevos: number;
  iguales: number;
  cambian: number;
  camposQueCambian: { campo: string; tickets: number }[];
  porFila: { fila: number; estado: EstadoEnBase; cambios: string[] }[];
}

const numero = (d: Decimal | null, decimales: number) => (d ? d.toDecimalPlaces(decimales).toNumber() : null);

export function resumenPreviaCompras(e: EntradaCompras) {
  const l = e.compras;
  const filas = new Set(l.compras.map((c) => c.fila));

  // Por fila: la incidencia más grave y sus mensajes, para la columna Revisión de la tabla
  const peso: Record<Severidad, number> = { ERROR: 3, ADVERTENCIA: 2, INFO: 1 };
  const porFila = new Map<number, { severidad: Severidad; cantidad: number; mensajes: string[] }>();
  for (const i of l.incidencias) {
    if (i.fila === undefined || !filas.has(i.fila)) continue;
    const a = porFila.get(i.fila);
    if (!a) porFila.set(i.fila, { severidad: i.severidad, cantidad: 1, mensajes: [i.mensaje] });
    else {
      a.cantidad++;
      if (a.mensajes.length < 3) a.mensajes.push(i.mensaje);
      if (peso[i.severidad] > peso[a.severidad]) a.severidad = i.severidad;
    }
  }

  const productos = new Map<string, { producto: string; lineas: number; cantidad: Decimal; total: Decimal; costo: Decimal; combustible: boolean }>();
  for (const c of l.compras) {
    if (c.anulada) continue;
    const nombre = c.producto.toUpperCase();
    let p = productos.get(nombre);
    if (!p) productos.set(nombre, (p = { producto: nombre, lineas: 0, cantidad: new Decimal(0), total: new Decimal(0), costo: new Decimal(0), combustible: esCombustible(nombre) }));
    p.lineas++;
    p.cantidad = p.cantidad.plus(c.cantidad);
    p.total = p.total.plus(c.total);
    if (c.fob_total) p.costo = p.costo.plus(c.fob_total);
  }

  return {
    tipo: e.tipo,
    token: e.token,
    archivo: e.nombre,
    bytes: e.datos.length,
    sha256: e.sha256,
    estacionUsada: e.estacion ?? null,
    estacionOrigen: e.estacionOrigen,
    valido: !l.incidencias.some((i) => i.severidad === 'ERROR') && l.compras.length > 0,
    hoja: l.hoja,
    filaEncabezado: l.filaEncabezado,
    // El reporte de compras nunca trae la columna Estación: siempre se usa la de la opción o la del .env
    traeEstacion: false,
    columnas: l.columnas.map((c) => ({ nombre: c.nombre, campo: c.campo })),
    resumen: { ...l.resumen, lineas: l.compras.length },
    cuadre: l.cuadre.map((f) => ({
      grupo: f.grupo,
      medida: f.medida,
      tickets: f.tickets,
      suma: f.sumaDetalle.toFixed(),
      reporte: f.valorReporte.toFixed(),
      diferencia: f.sumaDetalle.minus(f.valorReporte).toFixed(),
      cuadra: f.cuadra,
    })),
    conteoIncidencias: contarIncidencias(l.incidencias),
    incidencias: agruparIncidencias(l.incidencias, (i) => i.fila !== undefined && filas.has(i.fila)),
    productos: [...productos.values()]
      .map((p) => ({ ...p, cantidad: numero(p.cantidad, 3), total: numero(p.total, 2), costo: numero(p.costo, 2) }))
      .sort((a, b) => Number(b.combustible) - Number(a.combustible) || (b.cantidad ?? 0) - (a.cantidad ?? 0)),
    compras: l.compras.map((c) => ({
      fila: c.fila,
      turno: c.turno,
      factura: `${c.serie}-${c.numero}`,
      fechaHora: c.fecha_hora,
      proveedor: c.proveedor_nombre,
      producto: c.producto.toUpperCase(),
      combustible: esCombustible(c.producto),
      cantidad: numero(c.cantidad, 3),
      precio: numero(c.precio, 4),
      total: numero(c.total, 2),
      costo: numero(c.fob_total, 2),
      costoUnitario: numero(c.fob_unitario, 4),
      anulada: c.anulada,
      incidencia: porFila.get(c.fila) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Comparación con lo que ya está en la base, igual que dw.cargar_compras: cada línea se busca por
// estación, serie, número y producto, y "cambia" quiere decir que cambió dw.huella_compra()

const SQL_COMPARAR = `
WITH s AS (
  SELECT u.fila::int AS fila, u.est_codigo, trim(u.serie) AS serie, trim(u.numero) AS numero, upper(trim(u.producto)) AS prod,
         u.turno::int AS turno, u.fecha_hora::timestamp AS fecha_hora, u.nit, u.cantidad::numeric(14,5) AS cantidad,
         u.precio::numeric(14,6) AS precio, u.total::numeric(14,2) AS total, u.fob_total::numeric(18,6) AS fob_total,
         u.cif_total::numeric(18,6) AS cif_total, u.anulada::boolean AS anulada
    FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[])
         AS u(fila, est_codigo, serie, numero, producto, turno, fecha_hora, nit, cantidad, precio, total, fob_total, cif_total, anulada)
)
SELECT s.fila,
       f.hash_fila = dw.huella_compra(s.turno, s.fecha_hora, s.nit, s.cantidad, s.precio, s.total, s.fob_total, s.cif_total, s.anulada) AS igual,
       array_remove(ARRAY[
         CASE WHEN f.turno IS DISTINCT FROM s.turno THEN 'turno' END,
         CASE WHEN f.fecha_hora IS DISTINCT FROM s.fecha_hora THEN 'fecha y hora' END,
         CASE WHEN pr.nit IS DISTINCT FROM coalesce(upper(nullif(regexp_replace(coalesce(s.nit, ''), '[\\s-]', '', 'g'), '')), 'N/D') THEN 'proveedor' END,
         CASE WHEN f.cantidad IS DISTINCT FROM s.cantidad THEN 'galones' END,
         CASE WHEN f.precio_unitario IS DISTINCT FROM s.precio THEN 'precio' END,
         CASE WHEN f.monto_total IS DISTINCT FROM s.total THEN 'total' END,
         CASE WHEN round(f.fob_total, 4) IS DISTINCT FROM round(s.fob_total, 4) THEN 'costo FOB' END,
         CASE WHEN round(f.cif_total, 4) IS DISTINCT FROM round(s.cif_total, 4) THEN 'CIF' END,
         CASE WHEN f.anulada IS DISTINCT FROM s.anulada THEN 'anulada' END
       ], NULL) AS cambios
  FROM s
  JOIN dw.dim_estacion e  ON e.codigo = s.est_codigo
  JOIN dw.dim_producto p  ON p.nombre_origen = s.prod
  JOIN dw.fact_compra f   ON (f.estacion_key, f.factura_serie, f.factura_numero, f.producto_key) = (e.estacion_key, s.serie, s.numero, p.producto_key)
  JOIN dw.dim_proveedor pr ON pr.proveedor_key = f.proveedor_key`;

export async function compararCompras(e: EntradaCompras) {
  if (e.comparacion) return e.comparacion;
  const compras = e.compras.compras;
  const comparacion = await conCliente(async (c): Promise<ComparacionCompras> => {
    const previa = await buscarCargaDelMismoArchivo(c, e.sha256);
    if (previa) {
      return {
        yaCargado: { cargaId: previa.carga_id, archivo: previa.archivo_nombre, cuando: previa.terminado_en.toISOString() },
        nuevos: 0,
        iguales: compras.length,
        cambian: 0,
        camposQueCambian: [],
        porFila: [],
      };
    }
    // Sin la actualización 1.1.0 no hay con qué comparar: se dice qué ejecutar
    if (!(await tablasDeComprasInstaladas(c))) throw new ErrorConfiguracion(new ErrorSinTablasCompras().message);
    const r = await c.query<{ fila: number; igual: boolean; cambios: string[] }>(SQL_COMPARAR, [
      compras.map((x) => String(x.fila)),
      compras.map((x) => codigoEstacion(x.estacion)),
      compras.map((x) => x.serie),
      compras.map((x) => x.numero),
      compras.map((x) => x.producto),
      compras.map((x) => (x.turno === null ? null : String(x.turno))),
      compras.map((x) => x.fecha_hora),
      compras.map((x) => x.proveedor_nit),
      compras.map((x) => numeroStaging(x, 'cantidad')),
      compras.map((x) => numeroStaging(x, 'precio')),
      compras.map((x) => numeroStaging(x, 'total')),
      compras.map((x) => numeroStaging(x, 'fob_total')),
      compras.map((x) => numeroStaging(x, 'cif_total')),
      compras.map((x) => String(x.anulada)),
    ]);
    const enBase = new Map(r.rows.map((f) => [f.fila, f]));
    const campos = new Map<string, number>();
    const porFila = compras.map((x) => {
      const f = enBase.get(x.fila);
      if (!f) return { fila: x.fila, estado: 'NUEVO' as const, cambios: [] };
      if (f.igual) return { fila: x.fila, estado: 'IGUAL' as const, cambios: [] };
      const cambios = f.cambios.length ? f.cambios : ['otros datos'];
      cambios.forEach((k) => campos.set(k, (campos.get(k) ?? 0) + 1));
      return { fila: x.fila, estado: 'CAMBIA' as const, cambios };
    });
    const cuenta = (estado: EstadoEnBase) => porFila.filter((x) => x.estado === estado).length;
    return {
      yaCargado: null,
      nuevos: cuenta('NUEVO'),
      iguales: cuenta('IGUAL'),
      cambian: cuenta('CAMBIA'),
      camposQueCambian: [...campos.entries()].map(([campo, n]) => ({ campo, tickets: n })).sort((a, b) => b.tickets - a.tickets),
      porFila,
    };
  });
  e.comparacion = comparacion;
  return comparacion;
}
