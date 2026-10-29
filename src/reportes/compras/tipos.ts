import type { Decimal } from 'decimal.js';
import type { ColumnaDetectada as ColumnaTickets, Incidencia } from '../consulta-tickets/tipos.js';

export const CAMPOS_TEXTO_COMPRA = ['serie', 'numero', 'proveedor_nit', 'proveedor_nombre', 'producto', 'anulada', 'combustible'] as const;

/** Columnas numéricas y los decimales con que se guardan en stg.compra */
export const ESCALAS_COMPRA = {
  cantidad: 5,
  precio: 6,
  total: 2,
  fob_total: 6,
  fob_unitario: 9,
  cif_total: 6,
  cif_unitario: 9,
  f1: 6,
  f2: 6,
  f3: 6,
} as const;

export type CampoTextoCompra = (typeof CAMPOS_TEXTO_COMPRA)[number];
export type CampoNumeroCompra = keyof typeof ESCALAS_COMPRA;
export type CampoCompra = CampoTextoCompra | CampoNumeroCompra | 'turno' | 'fecha_hora';

/** Medidas que se suman y se comparan contra los subtotales del reporte */
export const MEDIDAS_CUADRE_COMPRA = ['cantidad', 'total', 'fob_total', 'cif_total'] as const satisfies readonly CampoNumeroCompra[];
export type MedidaCuadreCompra = (typeof MEDIDAS_CUADRE_COMPRA)[number];

/** Productos que se miden en galones y entran al inventario */
export const COMBUSTIBLES = ['DIESEL', 'REGULAR', 'SUPER'];

export interface Compra {
  fila: number;
  seccion: string | null;
  estacion: string;
  turno: number | null;
  serie: string;
  numero: string;
  /** Hora local, 'aaaa-mm-dd hh:mm:ss' */
  fecha_hora: string;
  proveedor_nit: string | null;
  proveedor_nombre: string | null;
  producto: string;
  cantidad: Decimal;
  precio: Decimal | null;
  total: Decimal;
  fob_total: Decimal | null;
  fob_unitario: Decimal | null;
  cif_total: Decimal | null;
  cif_unitario: Decimal | null;
  anulada: boolean;
  combustible: string | null;
  f1: Decimal | null;
  f2: Decimal | null;
  f3: Decimal | null;
}

export interface FilaCuadreCompra {
  grupo: string;
  medida: MedidaCuadreCompra;
  /** Líneas de compra sumadas (la columna se llama "tickets" en etl.cuadre) */
  tickets: number;
  sumaDetalle: Decimal;
  valorReporte: Decimal;
  tolerancia: Decimal;
  cuadra: boolean;
}

export type ColumnaDetectadaCompra = Omit<ColumnaTickets, 'campo'> & { campo: CampoCompra | null };

export interface ResultadoCompras {
  hoja: string;
  filaEncabezado: number;
  columnas: ColumnaDetectadaCompra[];
  compras: Compra[];
  cuadre: FilaCuadreCompra[];
  incidencias: Incidencia[];
  resumen: {
    estaciones: string[];
    proveedores: string[];
    turnoMin: number | null;
    turnoMax: number | null;
    fechaMin: string | null;
    fechaMax: string | null;
    total: string;
    /** Galones de combustible (sin lubricantes ni anuladas) */
    galones: string;
  };
}
