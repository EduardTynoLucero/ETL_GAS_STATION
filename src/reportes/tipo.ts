// Qué reporte de BISS es un archivo: se decide por las columnas del encabezado, no por el nombre del archivo.
import type { Hoja } from '../lector/excel.js';
import { filaDeTitulosCompras } from './compras/encabezado.js';

export type TipoReporte = 'CONSULTA_TICKETS' | 'COMPRAS';

export const NOMBRE_REPORTE: Record<TipoReporte, string> = {
  CONSULTA_TICKETS: 'Consulta de Tickets',
  COMPRAS: 'Reporte de compras',
};

/**
 * El Reporte de compras trae Serie, Numero y Cantidad, y no trae Ticket. Todo lo demás se lee como
 * Consulta de Tickets: si tampoco lo es, su lector explica qué columnas faltan.
 */
export function detectarTipo(hojas: Hoja[]): TipoReporte {
  return hojas.some((h) => filaDeTitulosCompras(h) !== null) ? 'COMPRAS' : 'CONSULTA_TICKETS';
}
