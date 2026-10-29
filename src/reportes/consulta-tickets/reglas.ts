// Reglas de calidad sobre los tickets ya convertidos. Ninguna detiene la carga:
// los errores que sí la detienen (fechas, números, repetidos, cuadre) se revisan en index.ts y cuadre.ts.
import { Decimal } from 'decimal.js';
import { normalizar } from './conversion.js';
import type { Incidencia, Ticket } from './tipos.js';

const TOLERANCIA_FORMULA = new Decimal('0.0001');
const TOLERANCIA_PRECIO = new Decimal('0.005');
const VENTANA_DUPLICADO_MS = 10 * 60 * 1000;

/** 'PCONC - GASOLINERA CONCEPCION LAS MINAS' -> 'PCONC' (igual que dw.cargar_tickets) */
export function codigoEstacion(estacion: string): string {
  const i = estacion.indexOf(' - ');
  return (i >= 0 ? estacion.slice(0, i) : estacion).trim();
}

/** Ajuste por galón según el nombre del pricebook: "descuento 2.00" -> -2, "Recargo Q1.00" -> +1 */
export function ajustePricebook(nombre: string | null): Decimal {
  if (!nombre) return new Decimal(0);
  const n = normalizar(nombre);
  const signo = n.startsWith('descuento') ? -1 : n.startsWith('recargo') ? 1 : 0;
  const m = /(\d+(\.\d+)?)/.exec(n);
  return signo === 0 || !m ? new Decimal(0) : new Decimal(m[1]!).times(signo);
}

/** Dígito verificador del NIT de Guatemala (módulo 11, K = 10). null si es CF o no parece NIT */
export function nitEsValido(nit: string | null): boolean | null {
  const v = (nit ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (v === '' || v === 'CF' || !/^\d+[\dK]$/.test(v)) return null;
  const cuerpo = v.slice(0, -1);
  let suma = 0;
  for (let i = 0; i < cuerpo.length; i++) suma += Number(cuerpo[i]) * (cuerpo.length + 1 - i);
  const r = (11 - (suma % 11)) % 11;
  return v.slice(-1) === (r === 10 ? 'K' : String(r));
}

const msDe = (fecha: string) => Date.parse(`${fecha.replace(' ', 'T')}Z`);

function formula(t: Ticket, columna: string, esperado: Decimal, viene: Decimal, descripcion: string): Incidencia | null {
  if (esperado.minus(viene).abs().lte(TOLERANCIA_FORMULA)) return null;
  return {
    severidad: 'ADVERTENCIA',
    regla: 'FORMULA',
    fila: t.fila,
    ticket: t.ticket,
    columna,
    valor: viene.toFixed(),
    mensaje: `Ticket ${t.ticket}, ${descripcion}: debería ser ${esperado.toFixed()} y viene ${viene.toFixed()}`,
  };
}

export function aplicarReglas(tickets: Ticket[]): Incidencia[] {
  const out: Incidencia[] = [];
  const agregar = (i: Incidencia | null) => i && out.push(i);

  for (const t of tickets) {
    if (t.total_neto && t.total) {
      const esperado = t.total.minus(t.iva ?? 0).minus(t.idp ?? 0);
      agregar(formula(t, 'total_neto', esperado, t.total_neto, 'Total neto = Total - IVA - IDP'));
    }
    if (t.costo_total && t.cantidad && t.costo_unitario) {
      agregar(formula(t, 'costo_total', t.cantidad.times(t.costo_unitario), t.costo_total, 'Costo = Cantidad x Costo unitario'));
    }
    if (t.utilidad && t.total_neto && t.costo_total) {
      agregar(formula(t, 'utilidad', t.total_neto.minus(t.costo_total), t.utilidad, 'Utilidad = Total neto - Costo'));
    }
    if (t.descuento && t.cantidad && t.precio_despacho && t.total) {
      const esperado = t.cantidad.times(t.precio_despacho).minus(t.total);
      agregar(formula(t, 'descuento', esperado, t.descuento, 'Descto. = Cantidad x Precio - Total'));
    }
    if (!t.producto) {
      out.push({
        severidad: 'ADVERTENCIA',
        regla: 'SIN_PRODUCTO',
        fila: t.fila,
        ticket: t.ticket,
        columna: 'producto',
        mensaje: `Ticket ${t.ticket} (fila ${t.fila}) no trae producto; entra como SIN PRODUCTO`,
      });
    } else if (t.seccion && normalizar(t.producto) !== normalizar(t.seccion)) {
      out.push({
        severidad: 'ADVERTENCIA',
        regla: 'PRODUCTO_DISTINTO_A_SECCION',
        fila: t.fila,
        ticket: t.ticket,
        columna: 'producto',
        valor: t.producto,
        mensaje: `Ticket ${t.ticket}: el producto ${t.producto} está en la sección ${t.seccion}`,
      });
    }
    if (t.precio_lista && t.precio_lista.gt(0) && t.precio_despacho) {
      const ajuste = ajustePricebook(t.pricebook);
      const esperado = t.precio_lista.plus(ajuste);
      if (t.precio_despacho.minus(esperado).abs().gte(TOLERANCIA_PRECIO)) {
        out.push({
          severidad: 'ADVERTENCIA',
          regla: 'PRECIO_FUERA_DE_PRICEBOOK',
          fila: t.fila,
          ticket: t.ticket,
          columna: 'precio_despacho',
          valor: t.precio_despacho.toFixed(),
          mensaje: `Ticket ${t.ticket}: precio ${t.precio_despacho.toFixed()} contra lista ${t.precio_lista.toFixed()} con ajuste ${ajuste.toFixed()} (${t.pricebook ?? 'sin pricebook'})`,
        });
      }
    }
    if (t.utilidad && t.utilidad.lt(0)) {
      out.push({
        severidad: 'INFO',
        regla: 'MARGEN_NEGATIVO',
        fila: t.fila,
        ticket: t.ticket,
        columna: 'utilidad',
        valor: t.utilidad.toFixed(),
        mensaje: `Ticket ${t.ticket}, venta bajo costo: costo unitario ${t.costo_unitario?.toFixed() ?? '?'} y precio ${t.precio_despacho?.toFixed() ?? '?'}`,
      });
    }
  }

  // Posible duplicado: misma bomba, mismos galones y monto, otro producto, en pocos minutos.
  // Los montos prefijados (Q100 de Super) se repiten seguido; por eso se exige que cambie el producto
  const porBomba = new Map<string, Ticket[]>();
  for (const t of tickets) {
    if (t.bomba === null) continue;
    const clave = `${codigoEstacion(t.estacion)}|${t.bomba}`;
    const lista = porBomba.get(clave) ?? [];
    lista.push(t);
    porBomba.set(clave, lista);
  }
  for (const lista of porBomba.values()) {
    lista.sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora) || a.ticket - b.ticket);
    for (let i = 1; i < lista.length; i++) {
      const a = lista[i - 1]!;
      const b = lista[i]!;
      if (
        a.cantidad && b.cantidad && a.cantidad.eq(b.cantidad) &&
        a.total && b.total && a.total.eq(b.total) &&
        normalizar(a.producto) !== normalizar(b.producto) &&
        msDe(b.fecha_hora) - msDe(a.fecha_hora) <= VENTANA_DUPLICADO_MS
      ) {
        out.push({
          severidad: 'ADVERTENCIA',
          regla: 'POSIBLE_DUPLICADO',
          fila: b.fila,
          ticket: b.ticket,
          mensaje: `Ticket ${b.ticket}: misma bomba ${b.bomba}, galones y monto que el ticket ${a.ticket} (${a.fecha_hora.slice(11, 16)}), con otro producto`,
        });
      }
    }
  }

  // Huecos en la numeración de tickets de cada estación
  const porEstacion = new Map<string, number[]>();
  for (const t of tickets) {
    const clave = codigoEstacion(t.estacion);
    const lista = porEstacion.get(clave) ?? [];
    lista.push(t.ticket);
    porEstacion.set(clave, lista);
  }
  for (const [estacion, numeros] of porEstacion) {
    const orden = [...new Set(numeros)].sort((a, b) => a - b);
    for (let i = 1; i < orden.length; i++) {
      const desde = orden[i - 1]! + 1;
      const hasta = orden[i]! - 1;
      if (hasta >= desde) {
        out.push({
          severidad: 'ADVERTENCIA',
          regla: 'TICKET_FALTANTE',
          ticket: desde,
          valor: desde === hasta ? String(desde) : `${desde}-${hasta}`,
          mensaje:
            desde === hasta
              ? `Falta el ticket ${desde} en ${estacion}`
              : `Faltan ${hasta - desde + 1} tickets en ${estacion}: del ${desde} al ${hasta}`,
        });
      }
    }
  }

  // NIT que no pasa el dígito verificador, uno por cliente
  const vistos = new Set<string>();
  for (const t of tickets) {
    const codigo = (t.cliente_codigo ?? '').trim().toUpperCase();
    if (!codigo || codigo === 'CF' || vistos.has(codigo)) continue;
    vistos.add(codigo);
    if (nitEsValido(t.cliente_nit) === false) {
      out.push({
        severidad: 'INFO',
        regla: 'NIT_INVALIDO',
        fila: t.fila,
        columna: 'cliente_nit',
        valor: t.cliente_nit ?? '',
        mensaje: `El NIT ${t.cliente_nit} del cliente ${codigo} (${(t.cliente_nombre ?? '').trim()}) no pasa el dígito verificador`,
      });
    }
  }

  return out;
}
