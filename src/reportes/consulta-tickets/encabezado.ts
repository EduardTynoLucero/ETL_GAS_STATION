// Ubica el encabezado de dos niveles del reporte y mapea cada columna a un campo por su nombre,
// nunca por su posición: la exportación de octubre trae Estación y la anterior no, y el orden cambia.
import type { Hoja } from '../../lector/excel.js';
import { aTexto, normalizar } from './conversion.js';
import type { Campo, ColumnaDetectada, Incidencia } from './tipos.js';

/** Nombres aceptados para cada campo, ya normalizados ("Título > Subtítulo" en minúsculas y sin tildes) */
export const ALIAS: Record<Campo, string[]> = {
  estacion: ['estacion'],
  turno: ['turno'],
  ticket: ['ticket'],
  bomba: ['bomba'],
  servicio: ['servicio'],
  credito: ['credito'],
  factura_serie: ['factura > serie'],
  factura_numero: ['factura > numero'],
  fecha_hora: ['fecha', 'fecha > hora', 'fecha hora'],
  cliente_codigo: ['cliente > cardcode', 'cliente > codigo'],
  cliente_nit: ['cliente > nit'],
  cliente_nombre: ['cliente > nombre'],
  vale: ['vale'],
  producto: ['poducto', 'producto'],
  cantidad: ['cantidad'],
  precio_despacho: ['precio > despacho'],
  precio_lista: ['precio > lista'],
  iva: ['iva'],
  idp: ['idp'],
  descuento: ['descto.', 'descto', 'descuento'],
  total: ['total'],
  total_neto: ['total neto'],
  costo_total: ['costo > costo', 'costo > total', 'costo'],
  costo_unitario: ['costo > unitario'],
  utilidad: ['utilidad > valor'],
  utilidad_pct: ['utilidad > %'],
  utilidad_unitario: ['utilidad > unitario'],
  pricebook: ['pricebook', 'price book'],
  plan_fidelidad: ['plan de fidelidad'],
};

export const OBLIGATORIOS: Campo[] = ['ticket', 'turno', 'fecha_hora', 'producto', 'cantidad', 'total', 'costo_total'];

const CAMPO_POR_NOMBRE = new Map<string, Campo>(
  (Object.entries(ALIAS) as [Campo, string[]][]).flatMap(([campo, nombres]) => nombres.map((n) => [n, campo] as const)),
);

export interface Encabezado {
  hoja: Hoja;
  filaEncabezado: number;
  filaInicioDatos: number;
  columnas: ColumnaDetectada[];
  col: Partial<Record<Campo, number>>;
}

const FILAS_A_REVISAR = 15;

function filaDeTitulos(hoja: Hoja): number | null {
  for (let r = 1; r <= Math.min(FILAS_A_REVISAR, hoja.filas); r++) {
    const textos = new Set<string>();
    for (let c = 1; c <= hoja.columnas; c++) textos.add(normalizar(hoja.valorConCombinadas(r, c)));
    if (textos.has('ticket') && textos.has('turno')) return r;
  }
  return null;
}

/** Busca la hoja que trae el reporte y arma el mapa de columnas */
export function leerEncabezado(hojas: Hoja[]): { encabezado: Encabezado | null; incidencias: Incidencia[] } {
  const incidencias: Incidencia[] = [];
  let hoja: Hoja | undefined;
  let fila: number | null = null;
  for (const h of hojas) {
    fila = filaDeTitulos(h);
    if (fila) {
      hoja = h;
      break;
    }
  }
  if (!hoja || !fila) {
    incidencias.push({
      severidad: 'ERROR',
      regla: 'ENCABEZADO_NO_ENCONTRADO',
      mensaje:
        `No encontré una fila con las columnas "Ticket" y "Turno" en las primeras ${FILAS_A_REVISAR} filas. ` +
        '¿Es el reporte Consulta de Tickets en modo Detalle?',
    });
    return { encabezado: null, incidencias };
  }

  // ¿Hay segunda fila de subtítulos? Si debajo del título "Ticket" ya hay un número, el encabezado es de una sola fila
  let colTicket = 0;
  for (let c = 1; c <= hoja.columnas; c++) if (normalizar(hoja.valorConCombinadas(fila, c)) === 'ticket') colTicket = c;
  const debajo = hoja.valor(fila + 1, colTicket);
  const dosNiveles = !(typeof debajo === 'number' || (typeof debajo === 'string' && /^\s*\d+\s*$/.test(debajo)));

  const columnas: ColumnaDetectada[] = [];
  const col: Partial<Record<Campo, number>> = {};
  for (let c = 1; c <= hoja.columnas; c++) {
    // El título de una celda combinada (Factura, Cliente, Precio, Costo, Utilidad) vale para todas sus columnas
    const tituloOriginal = aTexto(hoja.valorConCombinadas(fila, c))?.replace(/&nbsp;/gi, '').trim() ?? '';
    // Un título combinado en vertical (A2:A3, B2:B3...) deja la celda de abajo como secundaria: no hay subtítulo.
    // Ojo: en Costo el subtítulo también dice "Costo" (Costo > Costo es el costo total)
    const subOriginal = dosNiveles ? (aTexto(hoja.valor(fila + 1, c))?.trim() ?? '') : '';
    const titulo = normalizar(tituloOriginal);
    const sub = normalizar(subOriginal);
    const clave = titulo && sub ? `${titulo} > ${sub}` : titulo || sub;
    const nombre = tituloOriginal && subOriginal ? `${tituloOriginal} > ${subOriginal}` : tituloOriginal || subOriginal;
    if (!clave) continue; // columna sin nombre (la A trae "&nbsp;"): ahí van los nombres de sección
    const campo = CAMPO_POR_NOMBRE.get(clave) ?? null;
    columnas.push({ col: c, nombre, campo });
    if (!campo) {
      incidencias.push({
        severidad: 'INFO',
        regla: 'COLUMNA_NUEVA',
        columna: nombre,
        mensaje: `La columna "${nombre}" no es parte del formato conocido; se ignora`,
      });
    } else if (col[campo]) {
      incidencias.push({
        severidad: 'ERROR',
        regla: 'COLUMNA_REPETIDA',
        columna: nombre,
        mensaje: `Hay dos columnas para el campo ${campo}; no sé cuál usar`,
      });
    } else {
      col[campo] = c;
    }
  }

  for (const campo of OBLIGATORIOS) {
    if (!col[campo]) {
      incidencias.push({
        severidad: 'ERROR',
        regla: 'COLUMNA_OBLIGATORIA_FALTA',
        columna: campo,
        mensaje: `Falta la columna obligatoria "${ALIAS[campo][0]}"`,
      });
    }
  }

  return {
    encabezado: {
      hoja,
      filaEncabezado: fila,
      filaInicioDatos: fila + (dosNiveles ? 2 : 1),
      columnas,
      col,
    },
    incidencias,
  };
}
