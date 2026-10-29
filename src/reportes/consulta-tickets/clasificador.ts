// Clasifica cada fila del reporte: sección, ticket, subtotal, vacía u otra cosa.
import type { Hoja, ValorCelda } from '../../lector/excel.js';
import { aTexto, estaVacia } from './conversion.js';
import type { Encabezado } from './encabezado.js';
import { MEDIDAS_CUADRE } from './tipos.js';

export type TipoFila =
  | { tipo: 'vacia'; fila: number }
  | { tipo: 'seccion'; fila: number; nombre: string }
  | { tipo: 'ticket'; fila: number }
  | { tipo: 'subtotal'; fila: number }
  | { tipo: 'desconocida'; fila: number; contenido: string };

const esNumeroDeTicket = (v: ValorCelda) =>
  (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && /^\s*\d+\s*$/.test(v));

export function clasificarFila(hoja: Hoja, enc: Encabezado, fila: number): TipoFila {
  // Las celdas secundarias de una combinación devuelven null: una sección combinada A:AD cuenta como una sola celda
  const llenas: { col: number; valor: ValorCelda }[] = [];
  for (let c = 1; c <= hoja.columnas; c++) {
    const v = hoja.valor(fila, c);
    if (!estaVacia(v)) llenas.push({ col: c, valor: v });
  }
  if (llenas.length === 0) return { tipo: 'vacia', fila };

  const colTicket = enc.col.ticket!;
  if (esNumeroDeTicket(hoja.valor(fila, colTicket))) return { tipo: 'ticket', fila };

  const colsMedida = new Set(MEDIDAS_CUADRE.map((m) => enc.col[m]).filter((c): c is number => c !== undefined));
  const primera = llenas[0]!;
  if (llenas.length === 1 && typeof primera.valor === 'string' && !colsMedida.has(primera.col)) {
    return { tipo: 'seccion', fila, nombre: primera.valor.trim() };
  }
  if (estaVacia(hoja.valor(fila, colTicket)) && llenas.some((l) => colsMedida.has(l.col))) {
    return { tipo: 'subtotal', fila };
  }
  const contenido = llenas
    .slice(0, 4)
    .map((l) => aTexto(l.valor))
    .join(' | ');
  return { tipo: 'desconocida', fila, contenido };
}
