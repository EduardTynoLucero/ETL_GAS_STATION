import { describe, expect, it } from 'vitest';
import { evaluarTanque, PARAMETROS_POR_DEFECTO, sumarDias, type EntradaTanque } from '../src/panel/tanques.js';

// Tanque de 5,000 gal, entrega 1 día, reserva 1 día, mínimo 15 %, llenado 95 %, pedidos de 500, horizonte 7 días
const params = { ...PARAMETROS_POR_DEFECTO, capacidad_galones: 5000 };
const caso = (galones: number | null, consumo = 400, extra: Partial<EntradaTanque> = {}) =>
  evaluarTanque({ galonesDatos: galones, horasSinVentas: 0, consumoDiario: consumo, parametros: params, ahora: '2026-10-29 08:00', ...extra });

describe('semáforo de los tanques', () => {
  it('sin toma física no se puede saber', () => {
    expect(caso(null).estado).toBe('SIN_TOMA');
  });

  it('sin capacidad da galones y cobertura, pero no porcentaje', () => {
    const r = caso(2000, 400, { parametros: null });
    expect(r.estado).toBe('SIN_CAPACIDAD');
    expect(r.porcentaje).toBeNull();
    expect(r.coberturaDias).toBe(5);
  });

  it('urgente si un pedido de hoy no llega con la reserva', () => {
    // 700 gal / 400 por día = 1.75 días, menos que entrega + reserva (2)
    const r = caso(700);
    expect(r.estado).toBe('URGENTE');
    expect(r.diasParaPedir).toBe(0);
    // Al llegar mañana quedan 300 gal; llenar a 4,750 son 4,450: en múltiplos de 500, 4,000
    expect(r.pedidoSugerido).toBe(4000);
  });

  it('urgente por debajo del nivel mínimo aunque se venda poco', () => {
    expect(caso(600, 10).estado).toBe('URGENTE');
  });

  it('pronto si hay que pedir en los próximos 2 días', () => {
    // 1,500 / 400 = 3.75 días de cobertura: pedir en 1.75 días
    const r = caso(1500);
    expect(r.estado).toBe('PRONTO');
    expect(r.diasParaPedir).toBeCloseTo(1.75);
    // 29 oct 08:00 + 1.75 días = 31 oct 02:00
    expect(r.fechaPedido).toBe('2026-10-31 02:00');
  });

  it('programar dentro del horizonte, estable después', () => {
    expect(caso(3000).estado).toBe('PROGRAMAR'); // 7.5 días: pedir en 5.5
    expect(caso(4500, 300).estado).toBe('ESTABLE'); // 15 días: pedir en 13
  });

  it('una existencia negativa o mayor que el tanque se marca para revisar', () => {
    expect(caso(-50).estado).toBe('REVISAR');
    expect(caso(6000).estado).toBe('REVISAR');
  });

  it('descuenta lo vendido desde la última venta cargada', () => {
    const r = caso(2000, 480, { horasSinVentas: 12 });
    expect(r.estimado).toBe(true);
    expect(r.galones).toBeCloseTo(1760);
    expect(r.avisos[0]).toMatch(/12 horas/);
  });

  it('los umbrales del semáforo nunca bajan del mínimo', () => {
    const r = caso(4000, 10);
    expect(r.umbrales!.urgente).toBe(15);
    expect(r.umbrales!.pronto).toBe(15);
  });

  it('suma días con decimales a una fecha y hora', () => {
    expect(sumarDias('2026-10-29 08:00', 1.5)).toBe('2026-10-30 20:00');
  });
});
