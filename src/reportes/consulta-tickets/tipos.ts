import type { Decimal } from 'decimal.js';

export type Severidad = 'ERROR' | 'ADVERTENCIA' | 'INFO';

export interface Incidencia {
  severidad: Severidad;
  regla: string;
  mensaje: string;
  fila?: number;
  ticket?: number;
  columna?: string;
  valor?: string;
}

export const CAMPOS_TEXTO = [
  'estacion',
  'servicio',
  'credito',
  'factura_serie',
  'factura_numero',
  'cliente_codigo',
  'cliente_nit',
  'cliente_nombre',
  'vale',
  'producto',
  'pricebook',
  'plan_fidelidad',
] as const;

export const CAMPOS_ENTEROS = ['turno', 'ticket', 'bomba'] as const;

/** Columnas numéricas y los decimales con que se guardan en staging */
export const ESCALAS = {
  cantidad: 5,
  precio_despacho: 4,
  precio_lista: 4,
  iva: 6,
  idp: 6,
  descuento: 9,
  total: 2,
  total_neto: 6,
  costo_total: 9,
  costo_unitario: 4,
  utilidad: 9,
  utilidad_pct: 4,
  utilidad_unitario: 6,
} as const;

export type CampoTexto = (typeof CAMPOS_TEXTO)[number];
export type CampoEntero = (typeof CAMPOS_ENTEROS)[number];
export type CampoNumero = keyof typeof ESCALAS;
export type Campo = CampoTexto | CampoEntero | CampoNumero | 'fecha_hora';

/** Medidas que se suman y se comparan contra los subtotales del reporte */
export const MEDIDAS_CUADRE = [
  'cantidad',
  'iva',
  'idp',
  'descuento',
  'total',
  'total_neto',
  'costo_total',
  'utilidad',
] as const satisfies readonly CampoNumero[];
export type MedidaCuadre = (typeof MEDIDAS_CUADRE)[number];

export interface Ticket {
  fila: number;
  seccion: string | null;
  estacion: string;
  turno: number;
  ticket: number;
  bomba: number | null;
  servicio: string | null;
  credito: string | null;
  factura_serie: string | null;
  factura_numero: string | null;
  /** Hora local, 'aaaa-mm-dd hh:mm:ss' */
  fecha_hora: string;
  cliente_codigo: string | null;
  cliente_nit: string | null;
  cliente_nombre: string | null;
  vale: string | null;
  producto: string | null;
  cantidad: Decimal | null;
  precio_despacho: Decimal | null;
  precio_lista: Decimal | null;
  iva: Decimal | null;
  idp: Decimal | null;
  descuento: Decimal | null;
  total: Decimal | null;
  total_neto: Decimal | null;
  costo_total: Decimal | null;
  costo_unitario: Decimal | null;
  utilidad: Decimal | null;
  utilidad_pct: Decimal | null;
  utilidad_unitario: Decimal | null;
  pricebook: string | null;
  plan_fidelidad: string | null;
}

export interface ValorSubtotal {
  valor: Decimal;
  tolerancia: Decimal;
  texto: string;
}

export interface Subtotal {
  fila: number;
  valores: Partial<Record<MedidaCuadre, ValorSubtotal>>;
}

export interface Grupo {
  nombre: string;
  tickets: Ticket[];
  subtotal: Subtotal;
}

export interface FilaCuadre {
  grupo: string;
  medida: MedidaCuadre;
  tickets: number;
  sumaDetalle: Decimal;
  valorReporte: Decimal;
  tolerancia: Decimal;
  cuadra: boolean;
}

export interface ColumnaDetectada {
  col: number;
  nombre: string;
  campo: Campo | null;
}

export interface ResultadoLectura {
  hoja: string;
  filaEncabezado: number;
  columnas: ColumnaDetectada[];
  traeEstacion: boolean;
  tickets: Ticket[];
  grupos: Grupo[];
  totalGeneral: Subtotal | null;
  cuadre: FilaCuadre[];
  incidencias: Incidencia[];
  resumen: {
    estaciones: string[];
    turnoMin: number | null;
    turnoMax: number | null;
    fechaMin: string | null;
    fechaMax: string | null;
    total: string;
    cantidad: string;
  };
}

export const tieneErrores = (incidencias: Incidencia[]) => incidencias.some((i) => i.severidad === 'ERROR');
