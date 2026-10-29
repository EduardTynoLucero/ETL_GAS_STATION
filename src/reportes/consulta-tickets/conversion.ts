// Conversión de los valores de celda del reporte a números exactos, fechas y textos.
// Los montos nunca se suman como números de JavaScript: todo pasa por decimal.js.
import { Decimal } from 'decimal.js';
import type { ValorCelda } from '../../lector/excel.js';

/** Texto normalizado para comparar encabezados y secciones: minúsculas, sin tildes ni espacios de más */
export function normalizar(v: ValorCelda): string {
  if (v === null) return '';
  return String(v)
    .replace(/&nbsp;/gi, ' ')
    .replace(/ /g, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** ¿La celda está vacía? (incluye el "&nbsp;" que deja la exportación desde HTML) */
export function estaVacia(v: ValorCelda): boolean {
  if (v === null) return true;
  if (typeof v === 'string') return v.replace(/&nbsp;/gi, '').replace(/ /g, '').trim() === '';
  return false;
}

/** Texto tal como viene (sin tocar espacios internos); null si está vacío */
export function aTexto(v: ValorCelda): string | null {
  if (estaVacia(v)) return null;
  if (v instanceof Date) return fechaATexto(v);
  return String(v);
}

export class ValorInvalido extends Error {}

const NUMERO = /^[-+]?\d+(\.\d+)?$/;

/** Número exacto. Acepta número de Excel o texto con comas de miles ("8,605.07928") */
export function aDecimal(v: ValorCelda): Decimal | null {
  if (estaVacia(v)) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ValorInvalido(`"${v}" no es un número`);
    // String(v) da la representación más corta que vuelve al mismo número: 40.788208125, no 40.78820812500001
    return new Decimal(String(v));
  }
  if (typeof v === 'string') {
    const limpio = v.replace(/,/g, '').replace(/\s/g, '').replace(/^Q/i, '');
    if (!NUMERO.test(limpio)) throw new ValorInvalido(`"${v}" no es un número`);
    return new Decimal(limpio);
  }
  throw new ValorInvalido(`"${String(v)}" no es un número`);
}

/** Decimales que trae un texto o número tal como se ve ("18.01" -> 2) */
export function decimalesImpresos(v: ValorCelda): number {
  const t = typeof v === 'number' ? String(v) : String(v ?? '').replace(/,/g, '').trim();
  if (/e/i.test(t)) return new Decimal(t).decimalPlaces();
  const i = t.indexOf('.');
  return i < 0 ? 0 : t.length - i - 1;
}

export function aEntero(v: ValorCelda): number | null {
  if (estaVacia(v)) return null;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) {
    const n = Number(v.trim());
    if (Number.isSafeInteger(n)) return n;
  }
  throw new ValorInvalido(`"${String(v)}" no es un número entero`);
}

const dos = (n: number) => String(n).padStart(2, '0');

function fechaATexto(d: Date): string {
  // ExcelJS entrega las fechas reales de Excel como UTC con la hora de pared del archivo
  return (
    `${d.getUTCFullYear()}-${dos(d.getUTCMonth() + 1)}-${dos(d.getUTCDate())} ` +
    `${dos(d.getUTCHours())}:${dos(d.getUTCMinutes())}:${dos(d.getUTCSeconds())}`
  );
}

function armarFecha(anio: number, mes: number, dia: number, hora: number, minuto: number, segundo: number): string | null {
  const d = new Date(Date.UTC(anio, mes - 1, dia, hora, minuto, segundo));
  const valida =
    d.getUTCFullYear() === anio &&
    d.getUTCMonth() === mes - 1 &&
    d.getUTCDate() === dia &&
    d.getUTCHours() === hora &&
    d.getUTCMinutes() === minuto &&
    d.getUTCSeconds() === segundo;
  return valida ? fechaATexto(d) : null;
}

// "01/10/2026 2:06:49 PM", día primero; también "01/10/2026 14:06:49" y "1/10/2026 2:06 p. m."
const FECHA_TEXTO =
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s*m\.?)?)?$/i;

/** Fecha y hora local como 'aaaa-mm-dd hh:mm:ss'. Lanza ValorInvalido si no se puede leer */
export function aFechaHora(v: ValorCelda): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new ValorInvalido('fecha vacía o inválida');
    return fechaATexto(v);
  }
  if (typeof v === 'number' && v > 0 && v < 2958466) {
    // Número de serie de Excel: días desde el 30/12/1899
    const ms = Math.round((v - 25569) * 86400) * 1000;
    return fechaATexto(new Date(ms));
  }
  if (typeof v === 'string') {
    const m = FECHA_TEXTO.exec(v.replace(/ /g, ' ').trim());
    if (m) {
      const [, d, mes, a, h = '0', mi = '0', s = '0', ampm] = m;
      let hora = Number(h);
      if (ampm) {
        if (hora < 1 || hora > 12) throw new ValorInvalido(`"${v}" tiene una hora inválida`);
        // 12:xx AM es medianoche y 12:xx PM mediodía
        if (ampm.toLowerCase() === 'a') hora = hora === 12 ? 0 : hora;
        else hora = hora === 12 ? 12 : hora + 12;
      }
      const r = armarFecha(Number(a), Number(mes), Number(d), hora, Number(mi), Number(s));
      if (r) return r;
    }
  }
  throw new ValorInvalido(`"${String(v)}" no es una fecha dd/mm/aaaa h:mm:ss AM/PM`);
}

/** Texto para COPY: sin notación exponencial, redondeado a la escala de la columna */
export function decimalATexto(d: Decimal, escala: number): string {
  return d.toDecimalPlaces(escala, Decimal.ROUND_HALF_UP).toFixed();
}
