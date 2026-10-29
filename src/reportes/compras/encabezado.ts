// Ubica el encabezado del "Reporte de compras" y mapea cada columna a un campo por su nombre.
// El encabezado tiene dos niveles: FOB y CIF van combinados sobre "Costo/CIF" y "Unitario".
import type { Hoja } from '../../lector/excel.js';
import { aTexto, normalizar } from '../consulta-tickets/conversion.js';
import type { Incidencia } from '../consulta-tickets/tipos.js';
import type { CampoCompra, ColumnaDetectadaCompra } from './tipos.js';

/** Nombres aceptados para cada campo, ya normalizados ("Título > Subtítulo" en minúsculas y sin tildes) */
export const ALIAS_COMPRA: Record<CampoCompra, string[]> = {
  turno: ['turno'],
  serie: ['serie', 'factura > serie'],
  numero: ['numero', 'factura > numero'],
  fecha_hora: ['fecha', 'fecha > hora', 'fecha hora'],
  proveedor_nit: ['nit', 'proveedor > nit'],
  proveedor_nombre: ['cliente', 'proveedor', 'proveedor > nombre'],
  producto: ['poducto', 'producto'],
  cantidad: ['cantidad'],
  precio: ['precio'],
  total: ['total'],
  fob_total: ['fob > costo', 'fob > total', 'fob'],
  fob_unitario: ['fob > unitario'],
  cif_total: ['cif > cif', 'cif > total', 'cif'],
  cif_unitario: ['cif > unitario'],
  anulada: ['anulada'],
  combustible: ['combustible'],
  f1: ['f1'],
  f2: ['f2'],
  f3: ['f3'],
};

export const OBLIGATORIOS_COMPRA: CampoCompra[] = ['serie', 'numero', 'fecha_hora', 'producto', 'cantidad', 'total'];

const CAMPO_POR_NOMBRE = new Map<string, CampoCompra>(
  (Object.entries(ALIAS_COMPRA) as [CampoCompra, string[]][]).flatMap(([campo, nombres]) => nombres.map((n) => [n, campo] as const)),
);

/** Subtítulos que solo aparecen en la segunda fila del encabezado */
const SUBTITULOS = new Set(['costo', 'unitario', 'cif']);

export interface EncabezadoCompras {
  hoja: Hoja;
  filaEncabezado: number;
  filaInicioDatos: number;
  columnas: ColumnaDetectadaCompra[];
  col: Partial<Record<CampoCompra, number>>;
}

const FILAS_A_REVISAR = 15;

/** Fila de títulos del reporte de compras: trae Serie, Numero y Cantidad, y no trae Ticket */
export function filaDeTitulosCompras(hoja: Hoja): number | null {
  for (let r = 1; r <= Math.min(FILAS_A_REVISAR, hoja.filas); r++) {
    const textos = new Set<string>();
    for (let c = 1; c <= hoja.columnas; c++) textos.add(normalizar(hoja.valorConCombinadas(r, c)));
    if (textos.has('serie') && textos.has('numero') && textos.has('cantidad') && !textos.has('ticket')) return r;
  }
  return null;
}

export function leerEncabezadoCompras(hojas: Hoja[]): { encabezado: EncabezadoCompras | null; incidencias: Incidencia[] } {
  const incidencias: Incidencia[] = [];
  let hoja: Hoja | undefined;
  let fila: number | null = null;
  for (const h of hojas) {
    fila = filaDeTitulosCompras(h);
    if (fila) {
      hoja = h;
      break;
    }
  }
  if (!hoja || !fila) {
    incidencias.push({
      severidad: 'ERROR',
      regla: 'ENCABEZADO_NO_ENCONTRADO',
      mensaje: `No encontré una fila con las columnas "Serie", "Numero" y "Cantidad" en las primeras ${FILAS_A_REVISAR} filas. ¿Es el Reporte de compras de BISS?`,
    });
    return { encabezado: null, incidencias };
  }

  // Hay segunda fila de subtítulos si debajo de algún título dice Costo, Unitario o CIF
  let dosNiveles = false;
  for (let c = 1; c <= hoja.columnas; c++) if (SUBTITULOS.has(normalizar(hoja.valor(fila + 1, c)))) dosNiveles = true;

  const columnas: ColumnaDetectadaCompra[] = [];
  const col: Partial<Record<CampoCompra, number>> = {};
  for (let c = 1; c <= hoja.columnas; c++) {
    const tituloOriginal = aTexto(hoja.valorConCombinadas(fila, c))?.replace(/&nbsp;/gi, '').trim() ?? '';
    const subOriginal = dosNiveles ? (aTexto(hoja.valor(fila + 1, c))?.trim() ?? '') : '';
    const titulo = normalizar(tituloOriginal);
    const sub = normalizar(subOriginal);
    const clave = titulo && sub ? `${titulo} > ${sub}` : titulo || sub;
    const nombre = tituloOriginal && subOriginal ? `${tituloOriginal} > ${subOriginal}` : tituloOriginal || subOriginal;
    if (!clave) continue;
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
      incidencias.push({ severidad: 'ERROR', regla: 'COLUMNA_REPETIDA', columna: nombre, mensaje: `Hay dos columnas para el campo ${campo}; no sé cuál usar` });
    } else {
      col[campo] = c;
    }
  }

  for (const campo of OBLIGATORIOS_COMPRA) {
    if (!col[campo]) {
      incidencias.push({
        severidad: 'ERROR',
        regla: 'COLUMNA_OBLIGATORIA_FALTA',
        columna: campo,
        mensaje: `Falta la columna obligatoria "${ALIAS_COMPRA[campo][0]}"`,
      });
    }
  }

  return {
    encabezado: { hoja, filaEncabezado: fila, filaInicioDatos: fila + (dosNiveles ? 2 : 1), columnas, col },
    incidencias,
  };
}
