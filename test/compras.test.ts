import ExcelJS from 'exceljs';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { abrirExcelDesdeBuffer, type Hoja } from '../src/lector/excel.js';
import { procesarCompras } from '../src/reportes/compras/index.js';
import type { ResultadoCompras } from '../src/reportes/compras/tipos.js';
import { detectarTipo } from '../src/reportes/tipo.js';
import { crearReporte } from './fabrica.js';

// Arma en memoria un Reporte de compras con la forma que exporta BISS: título combinado, encabezado de dos
// niveles (FOB y CIF combinados sobre Costo/CIF y Unitario), secciones por producto, subtotales como texto
// con comas y total general. Los datos son inventados.

interface LineaPrueba {
  turno?: number;
  serie?: string;
  numero: string;
  fecha?: string;
  producto?: string;
  cantidad: number;
  precio: number;
  fobUnitario?: number;
  anulada?: string;
}

const ESTACION = 'PCONC - GASOLINERA CONCEPCION LAS MINAS';

const conComas = (d: Decimal, decimales: number) => {
  const [e, f] = d.toFixed(decimales).split('.');
  return e!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : '');
};

async function crearCompras(
  secciones: Record<string, LineaPrueba[]>,
  o: { alterarSubtotal?: Record<string, string>; sinTotalGeneral?: boolean } = {},
): Promise<Hoja[]> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Reporte de compras');
  ws.getCell(1, 1).value = 'Reporte de compras';
  ws.mergeCells(1, 1, 1, 19);
  const simples = ['Turno', 'Serie', 'Numero', 'Fecha', 'NIT', 'Cliente', 'Poducto', 'Cantidad', 'Precio', 'Total'];
  simples.forEach((t, i) => {
    ws.getCell(2, i + 1).value = t;
    ws.mergeCells(2, i + 1, 3, i + 1);
  });
  ws.getCell(2, 11).value = 'FOB';
  ws.mergeCells(2, 11, 2, 12);
  ws.getCell(2, 13).value = 'CIF';
  ws.mergeCells(2, 13, 2, 14);
  ws.getCell(3, 11).value = 'Costo';
  ws.getCell(3, 12).value = 'Unitario';
  ws.getCell(3, 13).value = 'CIF';
  ws.getCell(3, 14).value = 'Unitario';
  ['Anulada', 'Combustible', 'F1', 'F2', 'F3'].forEach((t, i) => {
    ws.getCell(2, 15 + i).value = t;
    ws.mergeCells(2, 15 + i, 3, 15 + i);
  });

  let fila = 4;
  const totales = { cantidad: new Decimal(0), total: new Decimal(0), fob: new Decimal(0) };
  for (const [seccion, lineas] of Object.entries(secciones)) {
    ws.getCell(fila, 1).value = seccion;
    ws.mergeCells(fila, 1, fila, 19);
    fila++;
    const sumas = { cantidad: new Decimal(0), total: new Decimal(0), fob: new Decimal(0) };
    for (const l of lineas) {
      const total = new Decimal(l.cantidad).times(l.precio).toDecimalPlaces(2);
      const fobUnitario = new Decimal(l.fobUnitario ?? l.precio / 1.12);
      const fob = fobUnitario.times(l.cantidad).toDecimalPlaces(4);
      const valores: ExcelJS.CellValue[] = [
        l.turno ?? 769, l.serie ?? 'B911FD19', l.numero, l.fecha ?? '05/10/2026 1:00:00 PM', '6986102', 'PUMA ENERGY',
        l.producto ?? seccion, l.cantidad, l.precio, total.toNumber(), fob.toNumber(), fobUnitario.toNumber(), fob.toNumber(),
        fobUnitario.toNumber(), l.anulada ?? '', '', 0, 0, 0,
      ];
      valores.forEach((v, i) => (ws.getCell(fila, i + 1).value = v));
      for (const s of [sumas, totales]) {
        s.cantidad = s.cantidad.plus(l.cantidad);
        s.total = s.total.plus(total);
        s.fob = s.fob.plus(fob);
      }
      fila++;
    }
    ws.getCell(fila, 8).value = conComas(sumas.cantidad, 3);
    ws.getCell(fila, 10).value = o.alterarSubtotal?.[seccion] ?? conComas(sumas.total, 2);
    ws.getCell(fila, 11).value = conComas(sumas.fob, 3);
    ws.getCell(fila, 13).value = conComas(sumas.fob, 3);
    fila++;
  }
  if (!o.sinTotalGeneral) {
    for (let c = 1; c <= 7; c++) ws.getCell(fila, c).value = '';
    ws.getCell(fila, 8).value = conComas(totales.cantidad, 2);
    ws.getCell(fila, 10).value = conComas(totales.total, 2);
    ws.getCell(fila, 11).value = conComas(totales.fob, 2);
    ws.getCell(fila, 13).value = conComas(totales.fob, 2);
  }
  return abrirExcelDesdeBuffer(await wb.xlsx.writeBuffer());
}

const reglas = (r: ResultadoCompras, severidad?: string) => r.incidencias.filter((i) => !severidad || i.severidad === severidad).map((i) => i.regla);

const secciones = {
  'SAE 40 LITRO PUMA': [{ numero: '40911826032', serie: '82026A1B', cantidad: 36, precio: 47.8125, fobUnitario: 42.6897 }],
  DIESEL: [
    { numero: '3225239766', cantidad: 2000, precio: 38.5125 },
    { numero: '1142440947', serie: '626F632E', fecha: '08/10/2026 6:30:00 AM', cantidad: 2000, precio: 38.5125 },
  ],
  SUPER: [{ numero: '3225239766', cantidad: 1500, precio: 32.97678 }],
};

describe('Reporte de compras', () => {
  it('se reconoce por sus columnas y la Consulta de Tickets también', async () => {
    expect(detectarTipo(await crearCompras(secciones))).toBe('COMPRAS');
    expect(detectarTipo(await crearReporte({ DIESEL: [{ ticket: 1, cantidad: 1 }] }))).toBe('CONSULTA_TICKETS');
  });

  it('lee líneas, secciones, subtotales y total general', async () => {
    const r = procesarCompras(await crearCompras(secciones), { estacion: ESTACION });
    expect(reglas(r, 'ERROR')).toEqual([]);
    expect(r.filaEncabezado).toBe(2);
    expect(r.compras.map((c) => [c.producto, c.numero])).toEqual([
      ['SAE 40 LITRO PUMA', '40911826032'],
      ['DIESEL', '3225239766'],
      ['DIESEL', '1142440947'],
      ['SUPER', '3225239766'],
    ]);
    expect(r.cuadre.length).toBeGreaterThan(0);
    expect(r.cuadre.every((f) => f.cuadra)).toBe(true);
    expect(new Set(r.cuadre.map((f) => f.grupo))).toEqual(new Set(['SAE 40 LITRO PUMA', 'DIESEL', 'SUPER', 'TOTAL GENERAL']));
    const d = r.compras[2]!;
    expect(d.fecha_hora).toBe('2026-10-08 06:30:00');
    expect(d.serie).toBe('626F632E');
    expect(d.estacion).toBe(ESTACION);
    expect(d.proveedor_nombre).toBe('PUMA ENERGY');
    expect(d.fob_total?.toNumber()).toBeCloseTo(2000 * (38.5125 / 1.12), 3);
    // Los galones de combustible no cuentan el lubricante
    expect(r.resumen.galones).toBe('5500');
    expect(r.resumen.estaciones).toEqual(['PCONC']);
    expect(reglas(r, 'INFO')).toContain('NO_ES_COMBUSTIBLE');
  });

  it('sin estación no se puede cargar: el reporte no la trae', async () => {
    const r = procesarCompras(await crearCompras(secciones));
    expect(reglas(r, 'ERROR')).toEqual(['ESTACION_FALTA']);
  });

  it('un subtotal que no cuadra rechaza el archivo', async () => {
    const r = procesarCompras(await crearCompras(secciones, { alterarSubtotal: { DIESEL: '1.00' } }), { estacion: ESTACION });
    expect(reglas(r, 'ERROR')).toContain('NO_CUADRA');
  });

  it('la misma factura y producto dos veces es un error; anulada y FOB con impuestos se avisan', async () => {
    const r = procesarCompras(
      await crearCompras({
        DIESEL: [
          { numero: '1', cantidad: 100, precio: 40, fobUnitario: 40 },
          { numero: '1', cantidad: 100, precio: 40 },
          { numero: '2', cantidad: 50, precio: 40, anulada: 'Sí' },
        ],
      }),
      { estacion: ESTACION },
    );
    expect(reglas(r, 'ERROR')).toEqual(['COMPRA_REPETIDA']);
    expect(reglas(r, 'INFO')).toEqual(expect.arrayContaining(['COMPRA_ANULADA', 'FOB_IGUAL_AL_TOTAL']));
    expect(r.compras.find((c) => c.numero === '2')?.anulada).toBe(true);
    // La anulada no suma galones
    expect(r.resumen.galones).toBe('200');
  });

  it('sin total general solo se cuadra contra los subtotales', async () => {
    const r = procesarCompras(await crearCompras(secciones, { sinTotalGeneral: true }), { estacion: ESTACION });
    expect(reglas(r, 'ERROR')).toEqual([]);
    expect(reglas(r, 'ADVERTENCIA')).toContain('TOTAL_NO_ENCONTRADO');
  });
});
