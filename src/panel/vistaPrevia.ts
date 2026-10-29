// Vista previa de un archivo subido desde el panel: se lee y se valida igual que en "validar",
// sin tocar la base, y se arma lo que el panel muestra antes de cargar. El archivo puede ser la
// Consulta de Tickets o el Reporte de compras: se reconoce por sus columnas.
import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { leerConfig } from '../config.js';
import { conCliente } from '../db.js';
import { abrirExcelDesdeBuffer } from '../lector/excel.js';
import { buscarCargaDelMismoArchivo } from '../carga/registro.js';
import { procesarCompras } from '../reportes/compras/index.js';
import type { ResultadoCompras } from '../reportes/compras/tipos.js';
import { procesarHojas } from '../reportes/consulta-tickets/index.js';
import { detectarTipo } from '../reportes/tipo.js';
import { agruparIncidencias } from './incidencias.js';
import { compararCompras, resumenPreviaCompras, type ComparacionCompras } from './previaCompras.js';
import { codigoEstacion } from '../reportes/consulta-tickets/reglas.js';
import { decimalATexto } from '../reportes/consulta-tickets/conversion.js';
import {
  ESCALAS,
  tieneErrores,
  type CampoNumero,
  type Incidencia,
  type ResultadoLectura,
  type Severidad,
  type Ticket,
} from '../reportes/consulta-tickets/tipos.js';

const VIGENCIA_MS = 30 * 60 * 1000;
const MAX_EN_MEMORIA = 4;
export const SIN_PRODUCTO = 'SIN PRODUCTO';

type EstadoEnBase = 'NUEVO' | 'IGUAL' | 'CAMBIA';

export interface Comparacion {
  yaCargado: { cargaId: number; archivo: string; cuando: string } | null;
  nuevos: number;
  iguales: number;
  cambian: number;
  /** Tickets que en la base tienen factura y en este archivo no (el último archivo manda) */
  pierdenFactura: number;
  /** Tickets que ya estaban con otra fecha: la carga los cambia de día */
  seMuevenDeDia: number;
  camposQueCambian: { campo: string; tickets: number }[];
  porTicket: Map<number, { estado: EstadoEnBase; cambios: string[] }>;
}

interface EntradaBase {
  token: string;
  nombre: string;
  datos: Buffer;
  sha256: string;
  estacion: string | undefined;
  /** De dónde salió la estación: la opción del panel, el .env o ninguna */
  estacionOrigen: 'opcion' | 'env' | null;
  creado: number;
}

export interface EntradaTickets extends EntradaBase {
  tipo: 'CONSULTA_TICKETS';
  lectura: ResultadoLectura;
  /** Por fila de Excel: la incidencia más grave y cuántas tiene */
  incidenciasPorFila: Map<number, { severidad: Severidad; cantidad: number; mensajes: string[] }>;
  comparacion?: Comparacion;
}

export interface EntradaCompras extends EntradaBase {
  tipo: 'COMPRAS';
  compras: ResultadoCompras;
  comparacion?: ComparacionCompras;
}

export type EntradaPrevia = EntradaTickets | EntradaCompras;

const previas = new Map<string, EntradaPrevia>();

function limpiarVencidas(): void {
  const ahora = Date.now();
  for (const [token, e] of previas) if (ahora - e.creado > VIGENCIA_MS) previas.delete(token);
  // Los archivos se guardan en memoria: solo los últimos
  const sobran = previas.size - MAX_EN_MEMORIA;
  if (sobran > 0) [...previas.keys()].slice(0, sobran).forEach((t) => previas.delete(t));
}

export function obtenerPrevia(token: string): EntradaPrevia | undefined {
  limpiarVencidas();
  return previas.get(token);
}

export function olvidarPrevia(token: string): void {
  previas.delete(token);
}

// ---------------------------------------------------------------------------------------------
// Agregados para las gráficas de la vista previa

const cero = () => new Decimal(0);
const suma = (a: Decimal, b: Decimal | null) => (b ? a.plus(b) : a);
const dinero = (d: Decimal) => d.toDecimalPlaces(2).toNumber();
const galones = (d: Decimal) => d.toDecimalPlaces(3).toNumber();
const nombreProducto = (t: Ticket) => t.producto?.trim().toUpperCase() || SIN_PRODUCTO;
const tieneFactura = (t: Ticket) => Boolean(t.factura_numero?.trim());
const claveFactura = (t: Ticket) => `${t.factura_serie?.trim() ?? ''}-${t.factura_numero?.trim() ?? ''}`;

interface Acumulado {
  tickets: number;
  galones: Decimal;
  total: Decimal;
  neto: Decimal;
  costo: Decimal;
  utilidad: Decimal;
}

const nuevoAcumulado = (): Acumulado => ({ tickets: 0, galones: cero(), total: cero(), neto: cero(), costo: cero(), utilidad: cero() });

function acumular(a: Acumulado, t: Ticket): void {
  a.tickets++;
  a.galones = suma(a.galones, t.cantidad);
  a.total = suma(a.total, t.total);
  a.neto = suma(a.neto, t.total_neto);
  a.costo = suma(a.costo, t.costo_total);
  a.utilidad = suma(a.utilidad, t.utilidad);
}

const salida = (a: Acumulado) => ({
  tickets: a.tickets,
  galones: galones(a.galones),
  total: dinero(a.total),
  neto: dinero(a.neto),
  costo: dinero(a.costo),
  utilidad: dinero(a.utilidad),
});

function agrupar<K>(tickets: Ticket[], clave: (t: Ticket) => K): Map<K, Acumulado> {
  const m = new Map<K, Acumulado>();
  for (const t of tickets) {
    const k = clave(t);
    let a = m.get(k);
    if (!a) m.set(k, (a = nuevoAcumulado()));
    acumular(a, t);
  }
  return m;
}

function agregados(tickets: Ticket[]) {
  const total = nuevoAcumulado();
  tickets.forEach((t) => acumular(total, t));

  const productos = [...agrupar(tickets, nombreProducto).entries()]
    .map(([producto, a]) => ({ producto, ...salida(a) }))
    .sort((a, b) => b.total - a.total);

  const porDia = [...agrupar(tickets, (t) => `${t.fecha_hora.slice(0, 10)}|${nombreProducto(t)}`).entries()]
    .map(([k, a]) => {
      const [fecha, producto] = k.split('|');
      return { fecha: fecha!, producto: producto!, ...salida(a) };
    })
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const porTurno = [...agrupar(tickets, (t) => `${t.turno}|${nombreProducto(t)}`).entries()]
    .map(([k, a]) => {
      const [turno, producto] = k.split('|');
      return { turno: Number(turno), producto: producto!, ...salida(a) };
    })
    .sort((a, b) => a.turno - b.turno);

  const porHora = [...agrupar(tickets, (t) => Number(t.fecha_hora.slice(11, 13))).entries()]
    .map(([hora, a]) => ({ hora, ...salida(a) }))
    .sort((a, b) => a.hora - b.hora);

  // Una factura con varios tickets es una factura global (la que se hace al cierre)
  const ticketsPorFactura = new Map<string, number>();
  for (const t of tickets) if (tieneFactura(t)) ticketsPorFactura.set(claveFactura(t), (ticketsPorFactura.get(claveFactura(t)) ?? 0) + 1);
  const facturacion = [...agrupar(tickets, (t) =>
    !tieneFactura(t) ? 'SIN FACTURA' : ticketsPorFactura.get(claveFactura(t))! > 1 ? 'FACTURA GLOBAL' : 'FACTURA INDIVIDUAL',
  ).entries()].map(([tipo, a]) => ({ tipo, ...salida(a) }));

  const clientes = [...agrupar(
    tickets.filter((t) => (t.cliente_codigo?.trim().toUpperCase() ?? '') !== 'CF'),
    (t) => `${t.cliente_codigo?.trim() || 'N/D'}|${t.cliente_nombre?.trim().replace(/\s+/g, ' ') || '(sin nombre)'}`,
  ).entries()]
    .map(([k, a]) => {
      const [codigo, nombre] = k.split('|');
      return { codigo: codigo!, nombre: nombre!, ...salida(a) };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const descuentoPorPricebook = new Map<string, Decimal>();
  for (const t of tickets) {
    const pb = t.pricebook?.trim() || 'Sin pricebook';
    const d = t.precio_lista?.gt(0) && t.precio_despacho && t.cantidad ? t.precio_lista.minus(t.precio_despacho).times(t.cantidad) : cero();
    descuentoPorPricebook.set(pb, (descuentoPorPricebook.get(pb) ?? cero()).plus(d));
  }
  const pricebooks = [...agrupar(tickets, (t) => t.pricebook?.trim() || 'Sin pricebook').entries()]
    .map(([pricebook, a]) => ({ pricebook, ...salida(a), descuento: dinero(descuentoPorPricebook.get(pricebook)!) }))
    .sort((a, b) => b.tickets - a.tickets);

  const sinFactura = nuevoAcumulado();
  tickets.filter((t) => !tieneFactura(t)).forEach((t) => acumular(sinFactura, t));

  return { total: salida(total), sinFactura: salida(sinFactura), productos, porDia, porTurno, porHora, facturacion, clientes, pricebooks };
}

/** Fila de Excel del ticket al que se refiere la incidencia, si se puede saber */
function filaDeIncidencia(i: Incidencia, filaDeTicket: Map<number, number>): number | undefined {
  // Un hueco de numeración nombra un ticket que no vino en el archivo: no tiene fila
  if (i.regla === 'TICKET_FALTANTE') return undefined;
  return i.fila ?? (i.ticket !== undefined ? filaDeTicket.get(i.ticket) : undefined);
}

const filasDeTickets = (lectura: ResultadoLectura) => new Map(lectura.tickets.map((t) => [t.ticket, t.fila]));

function incidenciasAgrupadas(lectura: ResultadoLectura) {
  const filaDeTicket = filasDeTickets(lectura);
  const filasEnTabla = new Set(lectura.tickets.map((t) => t.fila));
  // Se ve con el filtro "Con revisión" de la tabla solo si cae en la fila de un ticket del archivo
  return agruparIncidencias(lectura.incidencias, (i) => {
    const fila = filaDeIncidencia(i, filaDeTicket);
    return fila !== undefined && filasEnTabla.has(fila);
  });
}

function incidenciasPorFila(lectura: ResultadoLectura): EntradaTickets['incidenciasPorFila'] {
  const filaDeTicket = filasDeTickets(lectura);
  const peso: Record<Severidad, number> = { ERROR: 3, ADVERTENCIA: 2, INFO: 1 };
  const m: EntradaTickets['incidenciasPorFila'] = new Map();
  for (const i of lectura.incidencias) {
    const fila = filaDeIncidencia(i, filaDeTicket);
    if (fila === undefined) continue;
    const actual = m.get(fila);
    if (!actual) m.set(fila, { severidad: i.severidad, cantidad: 1, mensajes: [i.mensaje] });
    else {
      actual.cantidad++;
      if (actual.mensajes.length < 3) actual.mensajes.push(i.mensaje);
      if (peso[i.severidad] > peso[actual.severidad]) actual.severidad = i.severidad;
    }
  }
  return m;
}

function estacionPorDefecto(): string | undefined {
  try {
    return leerConfig().estacionPorDefecto;
  } catch {
    return undefined; // sin .env todavía: la vista previa igual funciona
  }
}

export async function crearVistaPrevia(datos: Buffer, nombre: string, estacion?: string) {
  limpiarVencidas();
  const estacionUsada = estacion?.trim() || estacionPorDefecto();
  const estacionOrigen = estacion?.trim() ? 'opcion' : estacionUsada ? 'env' : null;
  const hojas = await abrirExcelDesdeBuffer(datos);
  const base: EntradaBase = {
    token: randomUUID(),
    nombre,
    datos,
    sha256: createHash('sha256').update(datos).digest('hex'),
    estacion: estacionUsada,
    estacionOrigen,
    creado: Date.now(),
  };
  if (detectarTipo(hojas) === 'COMPRAS') {
    const entrada: EntradaCompras = { ...base, tipo: 'COMPRAS', compras: procesarCompras(hojas, { estacion: estacionUsada }) };
    previas.set(entrada.token, entrada);
    return resumenPreviaCompras(entrada);
  }
  const lectura = procesarHojas(hojas, { estacion: estacionUsada });
  const entrada: EntradaTickets = { ...base, tipo: 'CONSULTA_TICKETS', lectura, incidenciasPorFila: incidenciasPorFila(lectura) };
  previas.set(entrada.token, entrada);
  return resumenPrevia(entrada);
}

export function resumenPrevia(e: EntradaTickets) {
  const l = e.lectura;
  const conteo = { ERROR: 0, ADVERTENCIA: 0, INFO: 0 };
  for (const i of l.incidencias) conteo[i.severidad]++;
  return {
    tipo: e.tipo,
    token: e.token,
    archivo: e.nombre,
    bytes: e.datos.length,
    sha256: e.sha256,
    estacionUsada: e.estacion ?? null,
    estacionOrigen: e.estacionOrigen,
    valido: !tieneErrores(l.incidencias) && l.tickets.length > 0,
    hoja: l.hoja,
    filaEncabezado: l.filaEncabezado,
    traeEstacion: l.traeEstacion,
    columnas: l.columnas.map((c) => ({ nombre: c.nombre, campo: c.campo })),
    resumen: { ...l.resumen, tickets: l.tickets.length },
    cuadre: l.cuadre.map((f) => ({
      grupo: f.grupo,
      medida: f.medida,
      tickets: f.tickets,
      suma: f.sumaDetalle.toFixed(),
      reporte: f.valorReporte.toFixed(),
      diferencia: f.sumaDetalle.minus(f.valorReporte).toFixed(),
      cuadra: f.cuadra,
    })),
    conteoIncidencias: conteo,
    incidencias: incidenciasAgrupadas(l),
    agregados: agregados(l.tickets),
  };
}

// ---------------------------------------------------------------------------------------------
// Comparación con lo que ya está en la base: qué tickets son nuevos y cuáles cambiarían.
// Sigue a dw.cargar_tickets: el ticket se busca por estación y número (aunque cambie de día), y
// "cambia" quiere decir que cambió la huella hash_fila, calculada aquí con los mismos valores que
// recibiría staging. La consulta solo lee.

/** Columnas de staging que entran en la huella, con el tipo que tienen en stg.ticket_despacho */
const CAMPOS_HUELLA = {
  turno: 'int',
  bomba: 'int',
  factura_serie: 'text',
  factura_numero: 'text',
  fecha_hora: 'timestamp',
  cliente_codigo: 'text',
  vale: 'text',
  producto: 'text',
  cantidad: 'numeric(14,5)',
  precio_despacho: 'numeric(12,4)',
  precio_lista: 'numeric(12,4)',
  iva: 'numeric(18,6)',
  idp: 'numeric(18,6)',
  total: 'numeric(14,2)',
  costo_unitario: 'numeric(12,4)',
  pricebook: 'text',
  servicio: 'text',
  credito: 'text',
  plan_fidelidad: 'text',
} as const;
type CampoHuella = keyof typeof CAMPOS_HUELLA;
const NOMBRES_HUELLA = Object.keys(CAMPOS_HUELLA) as CampoHuella[];

/** El valor tal como se escribe en el CSV de staging (ver carga/staging.ts) */
function valorStaging(t: Ticket, campo: CampoHuella): string | null {
  const v = t[campo];
  if (v === null || v === undefined) return null;
  if (v instanceof Decimal) return decimalATexto(v, ESCALAS[campo as CampoNumero]);
  return String(v);
}

const SQL_COMPARAR = `
WITH s AS (
  SELECT u.fila::int AS fila, u.est_codigo, u.ticket::bigint AS ticket,
         ${NOMBRES_HUELLA.map((c) => `u.${c}::${CAMPOS_HUELLA[c]} AS ${c}`).join(',\n         ')}
    FROM unnest(${['fila', 'est_codigo', 'ticket', ...NOMBRES_HUELLA].map((_, i) => `$${i + 1}::text[]`).join(', ')})
         AS u(fila, est_codigo, ticket, ${NOMBRES_HUELLA.join(', ')})
), n AS (
  SELECT s.*,
         md5(concat_ws('|', s.turno, s.bomba, trim(s.factura_serie), trim(s.factura_numero), s.fecha_hora,
                       upper(trim(s.cliente_codigo)), trim(s.vale), upper(trim(s.producto)),
                       round(s.cantidad, 5), round(s.precio_despacho, 4), round(s.precio_lista, 4),
                       round(coalesce(s.iva, 0), 4), round(coalesce(s.idp, 0), 4), round(s.total, 2),
                       round(s.costo_unitario, 4), trim(s.pricebook), trim(s.servicio), trim(s.credito),
                       trim(s.plan_fidelidad))) AS hash_fila
    FROM s
)
SELECT n.fila,
       f.hash_fila = n.hash_fila AS igual,
       f.fecha_key <> to_char(n.fecha_hora, 'YYYYMMDD')::int AS cambia_de_dia,
       f.factura_numero IS NOT NULL AND nullif(trim(n.factura_numero), '') IS NULL AS pierde_factura,
       array_remove(ARRAY[
         CASE WHEN t1.numero IS DISTINCT FROM n.turno THEN 'turno' END,
         CASE WHEN b1.numero IS DISTINCT FROM coalesce(n.bomba, -1) THEN 'bomba' END,
         CASE WHEN f.fecha_hora IS DISTINCT FROM n.fecha_hora THEN 'fecha y hora' END,
         CASE WHEN concat_ws('-', f.factura_serie, f.factura_numero)
                   IS DISTINCT FROM concat_ws('-', nullif(trim(n.factura_serie), ''), nullif(trim(n.factura_numero), ''))
              THEN 'factura' END,
         CASE WHEN c1.codigo IS DISTINCT FROM coalesce(upper(nullif(trim(n.cliente_codigo), '')), 'N/D') THEN 'cliente' END,
         CASE WHEN p1.nombre_origen IS DISTINCT FROM coalesce(upper(nullif(trim(n.producto), '')), '(vacío)') THEN 'producto' END,
         CASE WHEN f.vale_numero IS DISTINCT FROM nullif(trim(n.vale), '') THEN 'vale' END,
         CASE WHEN f.cantidad_gal IS DISTINCT FROM n.cantidad THEN 'galones' END,
         CASE WHEN f.precio_despacho IS DISTINCT FROM n.precio_despacho THEN 'precio de despacho' END,
         CASE WHEN f.precio_lista IS DISTINCT FROM n.precio_lista THEN 'precio de lista' END,
         CASE WHEN f.monto_total IS DISTINCT FROM n.total THEN 'total' END,
         CASE WHEN round(f.iva, 4) IS DISTINCT FROM round(n.iva, 4) THEN 'IVA' END,
         CASE WHEN round(f.idp, 4) IS DISTINCT FROM round(n.idp, 4) THEN 'IDP' END,
         CASE WHEN f.costo_unitario IS DISTINCT FROM n.costo_unitario THEN 'costo unitario' END,
         CASE WHEN pb1.nombre_origen IS DISTINCT FROM coalesce(nullif(trim(n.pricebook), ''), '(vacío)') THEN 'pricebook' END,
         CASE WHEN v1.servicio IS DISTINCT FROM coalesce(nullif(trim(n.servicio), ''), 'N/D') THEN 'servicio' END,
         CASE WHEN v1.credito IS DISTINCT FROM coalesce(nullif(trim(n.credito), ''), 'N/D') THEN 'crédito' END,
         CASE WHEN v1.plan_fidelidad IS DISTINCT FROM coalesce(nullif(trim(n.plan_fidelidad), ''), 'N/D') THEN 'plan de fidelidad' END
       ], NULL) AS cambios
  FROM n
  JOIN dw.dim_estacion e    ON e.codigo = n.est_codigo
  JOIN dw.fact_despacho f   ON f.estacion_key = e.estacion_key AND f.ticket_numero = n.ticket
  JOIN dw.dim_turno t1      ON t1.turno_key = f.turno_key
  JOIN dw.dim_bomba b1      ON b1.bomba_key = f.bomba_key
  JOIN dw.dim_cliente c1    ON c1.cliente_key = f.cliente_key
  JOIN dw.dim_producto p1   ON p1.producto_key = f.producto_key
  JOIN dw.dim_pricebook pb1 ON pb1.pricebook_key = f.pricebook_key
  JOIN dw.dim_tipo_venta v1 ON v1.tipo_venta_key = f.tipo_venta_key`;

interface FilaComparada {
  fila: number;
  igual: boolean;
  cambia_de_dia: boolean;
  pierde_factura: boolean;
  cambios: string[];
}

export async function compararConBase(e: EntradaPrevia) {
  if (e.tipo === 'COMPRAS') return compararCompras(e);
  if (e.comparacion) return salidaComparacion(e.comparacion);
  const tickets = e.lectura.tickets;
  const comparacion = await conCliente(async (c): Promise<Comparacion> => {
    const previa = await buscarCargaDelMismoArchivo(c, e.sha256);
    if (previa) {
      // El mismo archivo ya entró: cargarlo otra vez queda como repetido y no toca nada
      return {
        yaCargado: { cargaId: previa.carga_id, archivo: previa.archivo_nombre, cuando: previa.terminado_en.toISOString() },
        nuevos: 0,
        iguales: tickets.length,
        cambian: 0,
        pierdenFactura: 0,
        seMuevenDeDia: 0,
        camposQueCambian: [],
        porTicket: new Map(),
      };
    }
    const r = await c.query<FilaComparada>(SQL_COMPARAR, [
      tickets.map((t) => String(t.fila)),
      tickets.map((t) => codigoEstacion(t.estacion)),
      tickets.map((t) => String(t.ticket)),
      ...NOMBRES_HUELLA.map((campo) => tickets.map((t) => valorStaging(t, campo))),
    ]);
    const enBase = new Map(r.rows.map((f) => [f.fila, f]));
    const porTicket: Comparacion['porTicket'] = new Map();
    const campos = new Map<string, number>();
    let pierdenFactura = 0;
    let seMuevenDeDia = 0;
    for (const t of tickets) {
      const f = enBase.get(t.fila);
      if (!f) {
        porTicket.set(t.fila, { estado: 'NUEVO', cambios: [] });
        continue;
      }
      if (f.igual) {
        porTicket.set(t.fila, { estado: 'IGUAL', cambios: [] });
        continue;
      }
      // La huella cambió por algo que no se ve campo por campo (espacios o mayúsculas, por ejemplo)
      const cambios = f.cambios.length ? f.cambios : ['otros datos'];
      cambios.forEach((x) => campos.set(x, (campos.get(x) ?? 0) + 1));
      if (f.pierde_factura) pierdenFactura++;
      if (f.cambia_de_dia) seMuevenDeDia++;
      porTicket.set(t.fila, { estado: 'CAMBIA', cambios });
    }
    const cuenta = (estado: EstadoEnBase) => [...porTicket.values()].filter((x) => x.estado === estado).length;
    return {
      yaCargado: null,
      nuevos: cuenta('NUEVO'),
      iguales: cuenta('IGUAL'),
      cambian: cuenta('CAMBIA'),
      pierdenFactura,
      seMuevenDeDia,
      camposQueCambian: [...campos.entries()].map(([campo, n]) => ({ campo, tickets: n })).sort((a, b) => b.tickets - a.tickets),
      porTicket,
    };
  });
  e.comparacion = comparacion;
  return salidaComparacion(comparacion);
}

const salidaComparacion = ({ porTicket: _, ...resto }: Comparacion) => resto;

// ---------------------------------------------------------------------------------------------
// Tabla de tickets de la vista previa, paginada en el servidor

export type FiltroTickets = 'todos' | 'incidencias' | 'sin-factura' | 'nuevos' | 'cambian';

export interface ConsultaTickets {
  pagina: number;
  porPagina: number;
  buscar?: string;
  producto?: string;
  filtro: FiltroTickets;
}

const normal = (v: string | null | undefined) => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};
const texto = (d: Decimal | null, decimales: number) => (d ? d.toDecimalPlaces(decimales).toNumber() : null);

export function ticketsDePrevia(e: EntradaTickets, q: ConsultaTickets) {
  const buscar = q.buscar?.trim().toLowerCase();
  const filas = e.lectura.tickets.filter((t) => {
    if (q.producto && nombreProducto(t) !== q.producto) return false;
    if (q.filtro === 'incidencias' && !e.incidenciasPorFila.has(t.fila)) return false;
    if (q.filtro === 'sin-factura' && tieneFactura(t)) return false;
    if (q.filtro === 'nuevos' && e.comparacion?.porTicket.get(t.fila)?.estado !== 'NUEVO') return false;
    if (q.filtro === 'cambian' && e.comparacion?.porTicket.get(t.fila)?.estado !== 'CAMBIA') return false;
    if (buscar) {
      const donde = [t.ticket, t.turno, t.cliente_codigo, t.cliente_nombre, t.cliente_nit, t.factura_numero, t.pricebook]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      if (!donde.includes(buscar)) return false;
    }
    return true;
  });
  const total = filas.length;
  const paginas = Math.max(1, Math.ceil(total / q.porPagina));
  const pagina = Math.min(Math.max(1, q.pagina), paginas);
  return {
    total,
    pagina,
    paginas,
    comparado: Boolean(e.comparacion && !e.comparacion.yaCargado),
    filas: filas.slice((pagina - 1) * q.porPagina, pagina * q.porPagina).map((t) => {
      const inc = e.incidenciasPorFila.get(t.fila);
      const cmp = e.comparacion?.porTicket.get(t.fila);
      return {
        fila: t.fila,
        ticket: t.ticket,
        turno: t.turno,
        fechaHora: t.fecha_hora,
        bomba: t.bomba,
        producto: nombreProducto(t),
        galones: texto(t.cantidad, 3),
        precio: texto(t.precio_despacho, 2),
        total: texto(t.total, 2),
        costo: texto(t.costo_total, 2),
        utilidad: texto(t.utilidad, 2),
        cliente: [normal(t.cliente_codigo), normal(t.cliente_nombre)?.replace(/\s+/g, ' ')].filter(Boolean).join(' · ') || null,
        factura: normal(t.factura_numero) ? [normal(t.factura_serie), normal(t.factura_numero)].filter(Boolean).join('-') : null,
        pricebook: normal(t.pricebook),
        incidencia: inc ? { severidad: inc.severidad, cantidad: inc.cantidad, mensajes: inc.mensajes } : null,
        enBase: cmp ? { estado: cmp.estado, cambios: cmp.cambios } : null,
      };
    }),
  };
}
