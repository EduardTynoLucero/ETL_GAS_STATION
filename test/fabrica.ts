// Arma en memoria un Excel con la misma forma que exporta BISS (título, encabezado de dos niveles
// con celdas combinadas, secciones combinadas, subtotales como texto con comas y total general).
// Los datos son inventados: las pruebas no usan archivos del cliente.
import ExcelJS from 'exceljs';
import { Decimal } from 'decimal.js';
import { abrirExcelDesdeBuffer, type Hoja } from '../src/lector/excel.js';

export interface TicketPrueba {
  ticket: number;
  turno?: number;
  bomba?: number;
  fecha?: string; // "dd/mm/aaaa h:mm:ss AM"
  producto?: string | null;
  cantidad: number;
  precio?: number; // despacho
  lista?: number;
  costoUnitario?: number;
  cliente?: [codigo: string, nit: string, nombre: string];
  pricebook?: string;
  factura?: [serie: string, numero: string];
}

export interface OpcionesFabrica {
  conEstacion?: boolean;
  /** Orden de columnas de la exportación anterior: Ticket primero y Turno después de Factura */
  ordenAnterior?: boolean;
  /** Nombre de la columna de producto, como lo escribe BISS */
  nombreProducto?: string;
  columnaExtra?: string;
  sinTotalGeneral?: boolean;
  /** Cambia lo impreso en el subtotal de una sección: { DIESEL: { total: '1.00' } } */
  alterarSubtotal?: Record<string, Partial<Record<string, string>>>;
  /** Quita el subtotal de esta sección */
  sinSubtotal?: string;
}

type Col = { titulo: string; sub?: string; valor: (t: TicketPrueba, d: Derivados) => ExcelJS.CellValue; medida?: string; decimales?: number };
interface Derivados { total: Decimal; costo: Decimal; utilidad: Decimal; descto: Decimal; precio: Decimal; lista: Decimal }

const ESTACION = 'PCONC - GASOLINERA CONCEPCION LAS MINAS';

function derivar(t: TicketPrueba): Derivados {
  const precio = new Decimal(t.precio ?? 40);
  const lista = new Decimal(t.lista ?? t.precio ?? 40);
  const cantidad = new Decimal(t.cantidad);
  const total = cantidad.times(precio).toDecimalPlaces(2);
  const costo = cantidad.times(t.costoUnitario ?? 35);
  return { total, costo, utilidad: total.minus(costo), descto: cantidad.times(precio).minus(total), precio, lista };
}

function columnas(o: OpcionesFabrica): Col[] {
  const cols: Record<string, Col> = {
    estacion: { titulo: 'Estación', valor: () => ESTACION },
    turno: { titulo: 'Turno', valor: (t) => t.turno ?? 800 },
    ticket: { titulo: 'Ticket', valor: (t) => t.ticket },
    bomba: { titulo: 'Bomba', valor: (t) => t.bomba ?? 1 },
    servicio: { titulo: 'Servicio', valor: () => 'Servicio completo' },
    credito: { titulo: 'Credito', valor: () => null },
    serie: { titulo: 'Factura', sub: 'Serie', valor: (t) => t.factura?.[0] ?? null },
    numero: { titulo: 'Factura', sub: 'Numero', valor: (t) => t.factura?.[1] ?? null },
    fecha: { titulo: 'Fecha', valor: (t) => t.fecha ?? '01/11/2026 8:00:00 AM' },
    codigo: { titulo: 'Cliente', sub: 'CardCode', valor: (t) => t.cliente?.[0] ?? 'CF' },
    nit: { titulo: 'Cliente', sub: 'NIT', valor: (t) => t.cliente?.[1] ?? 'CF' },
    nombre: { titulo: 'Cliente', sub: 'Nombre', valor: (t) => t.cliente?.[2] ?? 'CONSUMIDOR FINAL' },
    vale: { titulo: 'Vale', valor: () => null },
    producto: { titulo: o.nombreProducto ?? 'Poducto', valor: (t) => (t.producto === undefined ? 'DIESEL' : t.producto) },
    cantidad: { titulo: 'Cantidad', valor: (t) => t.cantidad, medida: 'cantidad', decimales: 5 },
    pdesp: { titulo: 'Precio', sub: 'Despacho', valor: (_t, d) => d.precio.toNumber() },
    plista: { titulo: 'Precio', sub: 'Lista', valor: (_t, d) => d.lista.toNumber() },
    iva: { titulo: 'IVA', valor: () => 0, medida: 'iva', decimales: 4 },
    idp: { titulo: 'IDP', valor: () => 0, medida: 'idp', decimales: 4 },
    descto: { titulo: 'Descto.', valor: (_t, d) => d.descto.toNumber(), medida: 'descto', decimales: 2 },
    total: { titulo: 'Total', valor: (_t, d) => d.total.toNumber(), medida: 'total', decimales: 4 },
    neto: { titulo: 'Total neto', valor: (_t, d) => d.total.toNumber(), medida: 'neto', decimales: 4 },
    costo: { titulo: 'Costo', sub: 'Costo', valor: (_t, d) => d.costo.toNumber(), medida: 'costo', decimales: 4 },
    cunit: { titulo: 'Costo', sub: 'Unitario', valor: (t) => t.costoUnitario ?? 35 },
    util: { titulo: 'Utilidad', sub: 'Valor', valor: (_t, d) => d.utilidad.toNumber(), medida: 'utilidad', decimales: 4 },
    upct: { titulo: 'Utilidad', sub: '%', valor: () => 0 },
    uunit: { titulo: 'Utilidad', sub: 'Unitario', valor: () => 0 },
    pricebook: { titulo: 'PriceBook', valor: (t) => t.pricebook ?? 'Precio de Lista' },
    plan: { titulo: 'Plan de Fidelidad', valor: () => 'No Aplica' },
  };
  const orden = o.ordenAnterior
    ? ['ticket', 'bomba', 'servicio', 'credito', 'serie', 'numero', 'turno', 'fecha', 'codigo', 'nit', 'nombre', 'vale']
    : ['estacion', 'turno', 'ticket', 'bomba', 'servicio', 'credito', 'serie', 'numero', 'fecha', 'codigo', 'nit', 'nombre', 'vale'];
  const resto = ['producto', 'cantidad', 'pdesp', 'plista', 'iva', 'idp', 'descto', 'total', 'neto', 'costo', 'cunit', 'util', 'upct', 'uunit', 'pricebook', 'plan'];
  const lista = [...orden, ...resto]
    .filter((k) => k !== 'estacion' || o.conEstacion !== false)
    .map((k) => cols[k]!);
  if (o.columnaExtra) lista.push({ titulo: o.columnaExtra, valor: () => 'x' });
  return lista;
}

const conComas = (d: Decimal, decimales: number) => {
  const [e, f] = d.toFixed(decimales).split('.');
  return e!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : '');
};

/** secciones: { DIESEL: [...tickets], SUPER: [...] } en el orden del reporte */
export async function crearReporte(secciones: Record<string, TicketPrueba[]>, o: OpcionesFabrica = {}): Promise<Hoja[]> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Consulta de Tickets');
  const cols = columnas(o);
  const n = cols.length + 1; // la columna A no tiene nombre
  ws.getCell(1, 1).value = 'Consulta de Tickets';
  ws.mergeCells(1, 1, 1, n);
  ws.getCell(2, 1).value = '&nbsp;';
  ws.mergeCells(2, 1, 3, 1);
  for (let i = 0; i < cols.length; ) {
    const c = cols[i]!;
    const col = i + 2;
    if (!c.sub) {
      ws.getCell(2, col).value = c.titulo;
      ws.mergeCells(2, col, 3, col);
      i++;
      continue;
    }
    let j = i;
    while (j < cols.length && cols[j]!.titulo === c.titulo && cols[j]!.sub) {
      ws.getCell(3, j + 2).value = cols[j]!.sub!;
      j++;
    }
    ws.getCell(2, col).value = c.titulo;
    if (j - i > 1) ws.mergeCells(2, col, 2, j + 1);
    i = j;
  }

  let fila = 4;
  const sumasTotales: Record<string, Decimal> = {};
  const escribirSubtotal = (sumas: Record<string, Decimal>, alterar: Partial<Record<string, string>> = {}) => {
    cols.forEach((c, i) => {
      if (!c.medida) return;
      ws.getCell(fila, i + 2).value = alterar[c.medida] ?? conComas(sumas[c.medida] ?? new Decimal(0), c.decimales ?? 2);
    });
    fila++;
  };

  for (const [seccion, tickets] of Object.entries(secciones)) {
    ws.getCell(fila, 1).value = seccion;
    ws.mergeCells(fila, 1, fila, n);
    fila++;
    const sumas: Record<string, Decimal> = {};
    for (const t of tickets) {
      const d = derivar(t);
      cols.forEach((c, i) => {
        const v = c.valor(t, d);
        ws.getCell(fila, i + 2).value = v;
        if (c.medida && typeof v === 'number') {
          sumas[c.medida] = (sumas[c.medida] ?? new Decimal(0)).plus(String(v));
          sumasTotales[c.medida] = (sumasTotales[c.medida] ?? new Decimal(0)).plus(String(v));
        }
      });
      fila++;
    }
    if (o.sinSubtotal !== seccion) escribirSubtotal(sumas, o.alterarSubtotal?.[seccion]);
  }
  if (!o.sinTotalGeneral) escribirSubtotal(sumasTotales);

  const buffer = await wb.xlsx.writeBuffer();
  return abrirExcelDesdeBuffer(buffer);
}
