// Llamadas al servidor del panel y estado compartido de la conexión a PostgreSQL.

export const bus = new EventTarget();
export const avisar = (evento, detalle) => bus.dispatchEvent(new CustomEvent(evento, { detail: detalle }));

export class ErrorApi extends Error {
  constructor(mensaje, estado, tipo) {
    super(mensaje);
    this.estado = estado;
    this.tipo = tipo;
  }
}

export async function pedir(url, opciones = {}) {
  let r;
  try {
    r = await fetch(url, opciones);
  } catch {
    throw new ErrorApi(
      'No hay respuesta del panel. Revisa que la ventana donde corriste "npm run panel" siga abierta y vuelve a intentar.',
      0,
      'panel',
    );
  }
  let datos;
  try {
    datos = await r.json();
  } catch {
    datos = { error: `Respuesta inesperada del panel (código ${r.status}).` };
  }
  if (!r.ok) throw new ErrorApi(datos.error ?? `Error ${r.status}`, r.status, datos.tipo);
  return datos;
}

/** Último resultado de /api/estado */
export const conexion = { revisando: true, conectado: false, datos: null };

let revisionEnCurso = null;

/** Vuelve a preguntar por la conexión. Si ya hay una revisión en curso, se espera esa (un solo /api/estado) */
export function revisarConexion() {
  if (revisionEnCurso) return revisionEnCurso;
  conexion.revisando = true;
  revisionEnCurso = (async () => {
    try {
      conexion.datos = await pedir('/api/estado');
      conexion.conectado = Boolean(conexion.datos.conectado && conexion.datos.bd?.esquemaInstalado);
    } catch (err) {
      conexion.datos = { conectado: false, tipo: err.tipo ?? 'panel', error: err.message, config: null, bd: null };
      conexion.conectado = false;
    }
    conexion.revisando = false;
    revisionEnCurso = null;
    avisar('conexion', conexion);
    return conexion;
  })();
  // El aviso del inicio va después de guardar la revisión: si alguien pide otra al oírlo, se le da esta
  avisar('conexion', conexion);
  return revisionEnCurso;
}

// Preferencias de esta PC (si el navegador no deja guardar, se sigue sin ellas)
export const preferencia = {
  leer(clave, porDefecto = null) {
    try {
      return localStorage.getItem(`etl-panel:${clave}`) ?? porDefecto;
    } catch {
      return porDefecto;
    }
  },
  guardar(clave, valor) {
    try {
      if (valor === null || valor === '') localStorage.removeItem(`etl-panel:${clave}`);
      else localStorage.setItem(`etl-panel:${clave}`, valor);
    } catch {
      // sin almacenamiento: no pasa nada
    }
  },
};
