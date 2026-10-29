// Formatos (es-GT), íconos de estado y ayudas para armar el HTML sin riesgo de inyección.

const nf = (min, max) => new Intl.NumberFormat('es-GT', { minimumFractionDigits: min, maximumFractionDigits: max });
const F0 = nf(0, 0);
const F1 = nf(1, 1);
const F2 = nf(2, 2);
const F01 = nf(0, 1);

/** Compacto a mano, con un decimal y siempre el mismo sufijo: '950', '3 k', '58.8 k', '1.2 M'.
 *  (notation: 'compact' de es-GT da '9 K' pero '10 k', y en un mismo eje parecen unidades distintas) */
function corto(n) {
  const a = Math.abs(n);
  const [divisor, sufijo] = a >= 999950 ? [1e6, ' M'] : a >= 999.95 ? [1e3, ' k'] : [1, ''];
  const texto = F01.format(a / divisor);
  return `${n < 0 && texto !== '0' ? '−' : ''}${texto}${sufijo}`;
}

const esNumero = (n) => typeof n === 'number' && Number.isFinite(n);

/** Todos los negativos con el mismo signo menos (U+2212) delante de todo: '−Q0.49/gal', '−9.6%', '−12 gal'.
 *  (el '-' de Intl va pegado al número, 'Q-0.49', y deja '-0.00' en lo que se redondea a cero) */
const conSigno = (n, formato, armar = (t) => t) => {
  const texto = formato.format(Math.abs(n));
  return `${n < 0 && texto !== formato.format(0) ? '−' : ''}${armar(texto)}`;
};

export const fmt = {
  entero: (n) => (esNumero(n) ? conSigno(n, F0) : '–'),
  moneda: (n) => (esNumero(n) ? conSigno(n, F2, (t) => `Q${t}`) : '–'),
  monedaEntera: (n) => (esNumero(n) ? conSigno(n, F0, (t) => `Q${t}`) : '–'),
  monedaCorta: (n) => (esNumero(n) ? corto(n).replace(/^(−?)/, '$1Q') : '–'),
  galones: (n) => (esNumero(n) ? conSigno(n, F2, (t) => `${t} gal`) : '–'),
  galonesCorto: (n) => (esNumero(n) ? `${corto(n)} gal` : '–'),
  numero: (n, d = 2) => (esNumero(n) ? conSigno(n, nf(d, d)) : '–'),
  compacto: (n) => (esNumero(n) ? corto(n) : '–'),
  pct: (n, d = 1) => (esNumero(n) ? conSigno(n, d === 1 ? F1 : nf(d, d), (t) => `${t}%`) : '–'),
  porGalon: (n) => (esNumero(n) ? conSigno(n, F2, (t) => `Q${t}/gal`) : '–'),
};

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/** '2026-10-01' -> '1 oct' (o '1 oct 2026' con anio) */
export function fecha(texto, anio = false) {
  if (!texto) return '–';
  const [a, m, d] = texto.slice(0, 10).split('-');
  return `${Number(d)} ${MESES[Number(m) - 1]}${anio ? ` ${a}` : ''}`;
}

/** '2026-10-01 07:15:49' -> '1 oct 2026, 07:15' */
export function fechaHora(texto, anio = true) {
  if (!texto) return '–';
  return `${fecha(texto, anio)}, ${texto.slice(11, 16)}`;
}

/** Fecha y hora de la base (ISO con zona) en la hora de esta PC, como fechaHora: '26 oct 2026, 07:55'.
 *  Con corto, el año solo va si no es el actual: '26 oct, 07:55' */
export function momento(iso, corto = false) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  const anio = !corto || d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  const dosDigitos = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MESES[d.getMonth()]}${anio}, ${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}`;
}

/** Día de la semana de una fecha 'aaaa-mm-dd' sin líos de zona horaria */
export function diaSemana(texto) {
  const [a, m, d] = texto.split('-').map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay(); // 0 = domingo
  return DIAS[(dia + 6) % 7];
}

export function escapar(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plantilla que escapa todo lo interpolado, salvo lo marcado con crudo() */
export function html(partes, ...valores) {
  return partes.reduce((acc, parte, i) => {
    if (i === 0) return parte;
    const v = valores[i - 1];
    const texto = Array.isArray(v) ? v.map((x) => (x && x.__crudo !== undefined ? x.__crudo : escapar(x))).join('') : v && v.__crudo !== undefined ? v.__crudo : escapar(v);
    return acc + texto + parte;
  }, '');
}
export const crudo = (texto) => ({ __crudo: String(texto) });

export function el(etiqueta, atributos = {}, contenido = '') {
  const e = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(atributos)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  if (contenido) e.innerHTML = contenido;
  return e;
}

// Íconos (trazo, heredan el color del texto)
const svg = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONOS = {
  bueno: svg('<circle cx="12" cy="12" r="10"/><path d="m8 12.5 2.6 2.6L16.2 9.5"/>'),
  aviso: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  serio: svg('<circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 16.5h.01"/>'),
  critico: svg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  subir: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>'),
  sol: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  luna: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  auto: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  tabla: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>'),
  grafica: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
};

/** Estado con ícono y texto (el color nunca va solo), en un renglón: para etiquetas cortas */
export function estado(tipo, texto) {
  return `<span class="estado estado-${tipo}">${ICONOS[tipo] ?? ICONOS.info}${escapar(texto)}</span>`;
}
/** Igual que estado(), para frases largas: el texto se parte en renglones y el ícono queda en el primero */
export function estadoLargo(tipo, texto) {
  return `<span class="estado estado-largo estado-${tipo}">${ICONOS[tipo] ?? ICONOS.info}<span>${escapar(texto)}</span></span>`;
}
export function insignia(tipo, texto) {
  return `<span class="insignia estado-${tipo}">${ICONOS[tipo] ?? ICONOS.info}${escapar(texto)}</span>`;
}

export const SEVERIDAD = {
  ERROR: { tipo: 'critico', texto: 'Error' },
  ADVERTENCIA: { tipo: 'aviso', texto: 'Advertencia' },
  INFO: { tipo: 'info', texto: 'Informativa' },
};

const REGLAS = {
  TICKET_FALTANTE: 'Tickets que faltan en la numeración',
  TICKET_NO_VINO: 'Tickets que ya estaban y no vienen en este archivo',
  FACTURA_QUITADA: 'Tickets que pierden su factura',
  SIN_PRODUCTO: 'Tickets sin producto',
  PRODUCTO_DISTINTO_A_SECCION: 'Producto distinto a la sección del reporte',
  PRECIO_FUERA_DE_PRICEBOOK: 'Precio fuera del pricebook',
  POSIBLE_DUPLICADO: 'Posibles tickets duplicados',
  NIT_INVALIDO: 'NIT que no pasa el dígito verificador',
  MARGEN_NEGATIVO: 'Vendidos abajo del costo',
  FORMULA: 'Cálculos del ticket que no cuadran',
  TICKET_REPETIDO: 'Ticket repetido en el archivo',
  SIN_TICKETS: 'El archivo no trae tickets',
  GRUPO_SIN_SUBTOTAL: 'Grupo sin subtotal',
  FILA_DESCONOCIDA: 'Filas que no se reconocen',
  ENCABEZADO_NO_ENCONTRADO: 'No se encontró el encabezado del reporte',
  COLUMNA_REPETIDA: 'Columna repetida',
  COLUMNA_OBLIGATORIA_FALTA: 'Falta una columna obligatoria',
  COLUMNA_NUEVA: 'Columnas que el ETL no usa',
  TOTAL_NO_ENCONTRADO: 'No se encontró el total general',
  SUBTOTAL_ILEGIBLE: 'Subtotal que no se puede leer',
  NO_CUADRA: 'No cuadra con los subtotales del reporte',
  ESTACION_FALTA: 'Falta la estación',
  NUMERO_INVALIDO: 'Números inválidos',
  VALOR_OBLIGATORIO_FALTA: 'Faltan datos obligatorios',
  FECHA_INVALIDA: 'Fechas inválidas',
};
export const nombreRegla = (r) => REGLAS[r] ?? r.charAt(0) + r.slice(1).toLowerCase().replace(/_/g, ' ');

export const plural = (n, uno, varios) => `${fmt.entero(n)} ${n === 1 ? uno : varios}`;
