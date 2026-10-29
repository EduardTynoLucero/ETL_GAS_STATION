import { describe, expect, it } from 'vitest';
import {
  aDecimal,
  aEntero,
  aFechaHora,
  decimalATexto,
  decimalesImpresos,
  estaVacia,
  normalizar,
} from '../src/reportes/consulta-tickets/conversion.js';
import { ajustePricebook, codigoEstacion, nitEsValido } from '../src/reportes/consulta-tickets/reglas.js';

describe('números', () => {
  it('lee los subtotales como texto con comas de miles', () => {
    expect(aDecimal('8,605.07928')!.toFixed()).toBe('8605.07928');
    expect(aDecimal('321,898.7767')!.toFixed()).toBe('321898.7767');
    expect(decimalesImpresos('321,898.7767')).toBe(4);
    expect(decimalesImpresos('18.01')).toBe(2);
    expect(decimalesImpresos(30)).toBe(0);
  });

  it('no arrastra el ruido de punto flotante de Excel', () => {
    expect(aDecimal(40.788208125)!.toFixed()).toBe('40.788208125');
    expect(aDecimal(0.1 + 0.2)!.toFixed()).toBe('0.30000000000000004');
    expect(aDecimal(1e-7)!.toFixed()).toBe('0.0000001');
  });

  it('vacíos y &nbsp; son nulos; un texto que no es número es error', () => {
    expect(aDecimal(null)).toBeNull();
    expect(aDecimal('&nbsp;')).toBeNull();
    expect(estaVacia('    ')).toBe(true);
    expect(() => aDecimal('abc')).toThrow();
    expect(() => aEntero('12.5')).toThrow();
    expect(aEntero('765')).toBe(765);
  });

  it('redondea a la escala de la columna sin notación exponencial', () => {
    expect(decimalATexto(aDecimal(50)!, 2)).toBe('50');
    expect(decimalATexto(aDecimal('8605.079284')!, 5)).toBe('8605.07928');
    expect(decimalATexto(aDecimal('0.000000005')!, 9)).toBe('0.000000005');
    expect(decimalATexto(aDecimal('1.000005')!, 5)).toBe('1.00001');
  });
});

describe('fechas', () => {
  it('lee dd/mm/aaaa con AM/PM, día primero', () => {
    expect(aFechaHora('01/10/2026 2:06:49 PM')).toBe('2026-10-01 14:06:49');
    expect(aFechaHora('23/10/2026 9:48:57 AM')).toBe('2026-10-23 09:48:57');
  });

  it('12 AM es medianoche y 12 PM es mediodía', () => {
    expect(aFechaHora('09/10/2026 12:05:00 AM')).toBe('2026-10-09 00:05:00');
    expect(aFechaHora('09/10/2026 12:05:00 PM')).toBe('2026-10-09 12:05:00');
    expect(aFechaHora('9/10/2026 1:05 p. m.')).toBe('2026-10-09 13:05:00');
  });

  it('acepta 24 horas, fechas reales de Excel y números de serie', () => {
    expect(aFechaHora('01/10/2026 14:06:49')).toBe('2026-10-01 14:06:49');
    expect(aFechaHora(new Date(Date.UTC(2026, 9, 1, 14, 6, 49)))).toBe('2026-10-01 14:06:49');
    expect(aFechaHora(46296.5)).toBe('2026-10-01 12:00:00');
  });

  it('rechaza fechas imposibles', () => {
    expect(() => aFechaHora('31/02/2026 1:00:00 AM')).toThrow();
    expect(() => aFechaHora('01/10/2026 13:00:00 PM')).toThrow();
    expect(() => aFechaHora('2026-10-01')).toThrow();
  });
});

describe('reglas auxiliares', () => {
  it('normaliza encabezados', () => {
    expect(normalizar(' Estación ')).toBe('estacion');
    expect(normalizar('&nbsp;')).toBe('');
  });

  it('separa el código de la estación', () => {
    expect(codigoEstacion('PCONC - GASOLINERA CONCEPCION LAS MINAS')).toBe('PCONC');
    expect(codigoEstacion('PCONC')).toBe('PCONC');
  });

  it('calcula el ajuste del pricebook', () => {
    expect(ajustePricebook('descuento 2.00').toFixed()).toBe('-2');
    expect(ajustePricebook('Recargo Q1.00').toFixed()).toBe('1');
    expect(ajustePricebook('Precio de Lista').toFixed()).toBe('0');
    expect(ajustePricebook(null).toFixed()).toBe('0');
  });

  it('valida el dígito verificador del NIT', () => {
    expect(nitEsValido('576937-K')).toBe(true);
    expect(nitEsValido('576937-5')).toBe(false);
    expect(nitEsValido('CF')).toBeNull();
    expect(nitEsValido(null)).toBeNull();
  });
});
