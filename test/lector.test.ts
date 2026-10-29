import { describe, expect, it } from 'vitest';
import { procesarHojas } from '../src/reportes/consulta-tickets/index.js';
import type { ResultadoLectura } from '../src/reportes/consulta-tickets/tipos.js';
import { crearReporte, type TicketPrueba } from './fabrica.js';

const diesel: TicketPrueba[] = [
  { ticket: 1001, cantidad: 10.12345, precio: 43.47, costoUnitario: 35.4375, fecha: '01/11/2026 6:00:00 AM' },
  { ticket: 1002, cantidad: 2.5, precio: 43.47, costoUnitario: 35.4375, fecha: '01/11/2026 6:10:00 AM', factura: ['7D20F439', '2919121178'] },
];
const superT: TicketPrueba[] = [
  { ticket: 1003, producto: 'SUPER', cantidad: 2.66099, precio: 37.58, costoUnitario: 32.1, bomba: 2, fecha: '01/11/2026 12:15:00 PM' },
  { ticket: 1004, producto: 'SUPER', cantidad: 5, precio: 35.58, lista: 37.58, pricebook: 'descuento 2.00', costoUnitario: 32.1, fecha: '01/11/2026 1:00:00 PM', cliente: ['C001', '576937K', 'CLIENTE DE PRUEBA  '] },
];

const reglas = (r: ResultadoLectura, severidad?: string) =>
  r.incidencias.filter((i) => !severidad || i.severidad === severidad).map((i) => i.regla);

describe('lectura del reporte', () => {
  it('lee la exportación con Estación: tickets, secciones, subtotales y total', async () => {
    const r = procesarHojas(await crearReporte({ DIESEL: diesel, SUPER: superT }));
    expect(reglas(r, 'ERROR')).toEqual([]);
    expect(r.filaEncabezado).toBe(2);
    expect(r.traeEstacion).toBe(true);
    expect(r.tickets.map((t) => t.ticket)).toEqual([1001, 1002, 1003, 1004]);
    expect(r.grupos.map((g) => [g.nombre, g.tickets.length])).toEqual([['DIESEL', 2], ['SUPER', 2]]);
    expect(r.totalGeneral).not.toBeNull();
    expect(r.cuadre.every((f) => f.cuadra)).toBe(true);
    expect(new Set(r.cuadre.map((f) => f.grupo))).toEqual(new Set(['DIESEL', 'SUPER', 'TOTAL GENERAL']));
    const t = r.tickets[1]!;
    expect(t.estacion).toBe('PCONC - GASOLINERA CONCEPCION LAS MINAS');
    expect(t.factura_serie).toBe('7D20F439');
    expect(t.factura_numero).toBe('2919121178');
    expect(t.fecha_hora).toBe('2026-11-01 06:10:00');
    expect(t.seccion).toBe('DIESEL');
    expect(r.tickets[2]!.fecha_hora).toBe('2026-11-01 12:15:00');
    // la fila de sección combinada A:AD no se confunde con un subtotal
    expect(reglas(r)).not.toContain('FILA_DESCONOCIDA');
  });

  it('lee la exportación anterior (sin Estación y con otro orden) si se indica la estación', async () => {
    const hojas = await crearReporte({ DIESEL: diesel }, { conEstacion: false, ordenAnterior: true, nombreProducto: 'Producto' });
    const sin = procesarHojas(hojas);
    expect(reglas(sin, 'ERROR')).toEqual(['ESTACION_FALTA']);
    const con = procesarHojas(hojas, { estacion: 'PCONC - GASOLINERA CONCEPCION LAS MINAS' });
    expect(reglas(con, 'ERROR')).toEqual([]);
    expect(con.traeEstacion).toBe(false);
    expect(con.tickets.map((t) => [t.ticket, t.turno])).toEqual([[1001, 800], [1002, 800]]);
  });

  it('rechaza el archivo si una suma no cuadra con el subtotal impreso', async () => {
    const r = procesarHojas(await crearReporte({ DIESEL: diesel, SUPER: superT }, { alterarSubtotal: { SUPER: { total: '1.0000' } } }));
    const errores = r.incidencias.filter((i) => i.severidad === 'ERROR');
    expect(errores.map((e) => e.regla)).toEqual(['NO_CUADRA']);
    expect(errores[0]!.mensaje).toContain('SUPER');
  });

  it('usa media unidad del último decimal impreso como tolerancia', async () => {
    // 10.12345 x 43.47 = 440.06637... -> el total del ticket es 440.07; Descto. impreso con 2 decimales
    const r = procesarHojas(await crearReporte({ DIESEL: diesel }));
    const descto = r.cuadre.find((f) => f.grupo === 'DIESEL' && f.medida === 'descuento')!;
    expect(descto.tolerancia.toFixed()).toBe('0.005');
    expect(descto.cuadra).toBe(true);
  });

  it('detecta un archivo cortado (tickets sin subtotal)', async () => {
    const r = procesarHojas(await crearReporte({ DIESEL: diesel, SUPER: superT }, { sinSubtotal: 'SUPER', sinTotalGeneral: true }));
    expect(reglas(r, 'ERROR')).toEqual(['GRUPO_SIN_SUBTOTAL']);
    expect(reglas(r)).toContain('TOTAL_NO_ENCONTRADO');
  });

  it('detecta tickets repetidos y huecos en la numeración', async () => {
    const r = procesarHojas(
      await crearReporte({ DIESEL: [diesel[0]!, { ...diesel[1]!, ticket: 1001 }], SUPER: [{ ...superT[0]!, ticket: 1005 }] }),
    );
    expect(reglas(r, 'ERROR')).toEqual(['TICKET_REPETIDO']);
    const faltante = r.incidencias.find((i) => i.regla === 'TICKET_FALTANTE')!;
    expect(faltante.valor).toBe('1002-1004');
  });

  it('avisa sin detener: sin producto, posible duplicado, precio fuera de pricebook, columna nueva', async () => {
    const r = procesarHojas(
      await crearReporte(
        {
          SUPER: [
            { ticket: 2001, producto: 'SUPER', cantidad: 0.834, precio: 35.99, bomba: 2, fecha: '23/11/2026 8:53:00 AM' },
            { ticket: 2002, producto: 'SUPER', cantidad: 3, precio: 37.5999, lista: 37.59, bomba: 3, fecha: '23/11/2026 8:54:00 AM' },
          ],
          '': [{ ticket: 2003, producto: null, cantidad: 0.834, precio: 35.99, bomba: 2, fecha: '23/11/2026 8:56:00 AM' }],
        },
        { columnaExtra: 'Turno Cajero' },
      ),
    );
    expect(reglas(r, 'ERROR')).toEqual([]);
    const avisos = reglas(r);
    expect(avisos).toContain('SIN_PRODUCTO');
    expect(avisos).toContain('POSIBLE_DUPLICADO');
    expect(avisos).toContain('PRECIO_FUERA_DE_PRICEBOOK');
    expect(avisos).toContain('COLUMNA_NUEVA');
  });

  it('el descuento de pricebook no es precio fuera de pricebook y el NIT se valida', async () => {
    const r = procesarHojas(await crearReporte({ SUPER: superT }));
    expect(reglas(r)).not.toContain('PRECIO_FUERA_DE_PRICEBOOK');
    expect(reglas(r)).not.toContain('NIT_INVALIDO');
    const r2 = procesarHojas(
      await crearReporte({ SUPER: [{ ...superT[1]!, cliente: ['C19092024008', '19092024008', 'CLIENTE'] }] }),
    );
    expect(reglas(r2)).toContain('NIT_INVALIDO');
  });

  it('rechaza un libro que no es el reporte', async () => {
    const r = procesarHojas([
      { nombre: 'Hoja1', filas: 2, columnas: 2, valor: () => 'x', valorConCombinadas: () => 'x' },
    ]);
    expect(reglas(r, 'ERROR')).toEqual(['ENCABEZADO_NO_ENCONTRADO']);
  });
});
