// Cuadre contra el propio reporte: la suma de los tickets leídos de cada grupo debe dar el subtotal
// impreso, y la de todos los tickets el total general. Tolerancia: media unidad del último decimal impreso.
import { Decimal } from 'decimal.js';
import type { Hoja } from '../../lector/excel.js';
import { aDecimal, decimalesImpresos, estaVacia, ValorInvalido } from './conversion.js';
import type { Encabezado } from './encabezado.js';
import {
  MEDIDAS_CUADRE,
  type FilaCuadre,
  type Grupo,
  type Incidencia,
  type Subtotal,
  type Ticket,
  type ValorSubtotal,
} from './tipos.js';

// Un subtotal guardado como número (no como texto) puede traer ruido de punto flotante en el último decimal
const TOLERANCIA_MINIMA_NUMERO = new Decimal('0.0001');

export function leerSubtotal(hoja: Hoja, enc: Encabezado, fila: number, incidencias: Incidencia[]): Subtotal {
  const valores: Subtotal['valores'] = {};
  for (const medida of MEDIDAS_CUADRE) {
    const col = enc.col[medida];
    if (!col) continue;
    const v = hoja.valor(fila, col);
    if (estaVacia(v)) continue;
    try {
      const valor = aDecimal(v)!;
      let tolerancia = new Decimal(5).times(new Decimal(10).pow(-(decimalesImpresos(v) + 1)));
      if (typeof v === 'number') tolerancia = Decimal.max(tolerancia, TOLERANCIA_MINIMA_NUMERO);
      const vs: ValorSubtotal = { valor, tolerancia, texto: String(v) };
      valores[medida] = vs;
    } catch (err) {
      if (!(err instanceof ValorInvalido)) throw err;
      incidencias.push({
        severidad: 'ERROR',
        regla: 'SUBTOTAL_ILEGIBLE',
        fila,
        columna: medida,
        valor: String(v),
        mensaje: `El subtotal de ${medida} no se puede leer: ${err.message}`,
      });
    }
  }
  return { fila, valores };
}

function sumar(tickets: Ticket[], medida: (typeof MEDIDAS_CUADRE)[number]): Decimal {
  let s = new Decimal(0);
  for (const t of tickets) {
    const v = t[medida];
    if (v) s = s.plus(v);
  }
  return s;
}

function compararGrupo(nombre: string, tickets: Ticket[], subtotal: Subtotal): FilaCuadre[] {
  const filas: FilaCuadre[] = [];
  for (const medida of MEDIDAS_CUADRE) {
    const impreso = subtotal.valores[medida];
    if (!impreso) continue;
    const suma = sumar(tickets, medida);
    filas.push({
      grupo: nombre,
      medida,
      tickets: tickets.length,
      sumaDetalle: suma,
      valorReporte: impreso.valor,
      tolerancia: impreso.tolerancia,
      cuadra: suma.minus(impreso.valor).abs().lte(impreso.tolerancia),
    });
  }
  return filas;
}

export function cuadrar(
  grupos: Grupo[],
  totalGeneral: Subtotal | null,
  todos: Ticket[],
): { filas: FilaCuadre[]; incidencias: Incidencia[] } {
  const filas: FilaCuadre[] = [];
  for (const g of grupos) filas.push(...compararGrupo(g.nombre, g.tickets, g.subtotal));
  if (totalGeneral) filas.push(...compararGrupo('TOTAL GENERAL', todos, totalGeneral));

  const incidencias: Incidencia[] = filas
    .filter((f) => !f.cuadra)
    .map((f) => ({
      severidad: 'ERROR' as const,
      regla: 'NO_CUADRA',
      columna: f.medida,
      valor: f.sumaDetalle.toFixed(),
      mensaje:
        `${f.grupo}: la suma de ${f.medida} de los ${f.tickets} tickets da ${f.sumaDetalle.toFixed()} ` +
        `y el reporte dice ${f.valorReporte.toFixed()} (diferencia ${f.sumaDetalle.minus(f.valorReporte).toFixed()})`,
    }));
  if (!totalGeneral) {
    incidencias.push({
      severidad: 'ADVERTENCIA',
      regla: 'TOTAL_NO_ENCONTRADO',
      mensaje: 'El archivo no trae la fila de total general; solo se cuadró contra los subtotales',
    });
  }
  return { filas, incidencias };
}
