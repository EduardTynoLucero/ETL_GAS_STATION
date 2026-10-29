// Línea de comandos del ETL.
//   npm run instalar-bd [-- --crear-base]
//   npm run probar-conexion
//   npm run validar -- "C:\ruta\DATA_TICKETS_DESPACHOS.xlsx"
//   npm run cargar  -- "C:\ruta\DATA_TICKETS_DESPACHOS.xlsx" [--estacion "PCONC - ..."]
//   npm run vigilar [-- --una-vez]
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { instalarBaseDeDatos, probarConexion } from './bd/instalar.js';
import { cargarArchivo } from './carga/cargar.js';
import { procesarCarpeta, vigilar } from './carga/vigilar.js';
import { ErrorConfiguracion, existeEnv, leerConfig } from './config.js';
import { cerrarPool, esErrorDeConexion, explicarErrorConexion } from './db.js';
import { abrirExcel, ErrorArchivo } from './lector/excel.js';
import { procesarCompras } from './reportes/compras/index.js';
import { procesarHojas } from './reportes/consulta-tickets/index.js';
import { tieneErrores } from './reportes/consulta-tickets/tipos.js';
import { detectarTipo, NOMBRE_REPORTE } from './reportes/tipo.js';
import { miles, resumenJson, textoCarga, textoCompras, textoLectura } from './resumen.js';

const AYUDA = `ETL de los reportes "Consulta de Tickets" y "Reporte de compras" (BISS) hacia PostgreSQL
Cada archivo se reconoce solo por sus columnas: no hace falta decir de qué reporte es.

Comandos:
  npm run instalar-bd                      Instala las tablas del ETL en la base del .env (se puede repetir)
  npm run probar-conexion                  Revisa la conexión y si las tablas ya están instaladas
  npm run validar -- "archivo.xlsx"        Lee y revisa el archivo sin cargar nada (no necesita la base)
  npm run cargar -- "archivo.xlsx" [...]   Carga uno o varios archivos
  npm run vigilar                          Carga lo que aparezca en la carpeta de entrada (Ctrl+C para salir)

Opciones:
  --estacion "PCONC - GASOLINERA CONCEPCION LAS MINAS"
                 Para archivos que no traen la columna Estación, como el Reporte de compras (si no, usa ETL_ESTACION_POR_DEFECTO)
  --usuario "nombre"   Quién sube el archivo (si no, ETL_USUARIO o el usuario de Windows)
  --json         Imprime el resultado en JSON
  --una-vez      Con vigilar: procesa la carpeta una vez y termina
  --crear-base   Con instalar-bd: crea la base si no existe (servidor nuevo; en Dokploy ya existe)`;

// npm ejecuta los scripts desde la carpeta del proyecto; las rutas relativas se toman desde donde se escribió el comando
const rutaDesdeUsuario = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);

const archivos = (n: number) => `${n} ${n === 1 ? 'archivo' : 'archivos'}`;

function leerArgumentos() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        estacion: { type: 'string' },
        usuario: { type: 'string' },
        json: { type: 'boolean', default: false },
        'una-vez': { type: 'boolean', default: false },
        'crear-base': { type: 'boolean', default: false },
        ayuda: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    // Una opción mal escrita (por ejemplo --crear-bd) da un error de Node en inglés con su traza
    const codigo = String((err as { code?: string }).code);
    if (!codigo.startsWith('ERR_PARSE_ARGS_')) throw err;
    const opcion = (/'([^']+)'/.exec((err as Error).message)?.[1] ?? '').replace(/ <value>$/, '');
    const problema =
      codigo === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
        ? `No conozco la opción ${opcion}.`
        : `La opción ${opcion} está mal escrita: le falta su valor, o lleva un valor que no le corresponde.`;
    throw new ErrorUso(`${problema}\n\n${AYUDA}`);
  }
}

async function main(): Promise<number> {
  const { positionals, values } = leerArgumentos();
  const [comando, ...rutas] = positionals;
  if (!comando || values.ayuda || comando === 'ayuda') {
    console.log(AYUDA);
    return 0;
  }

  switch (comando) {
    case 'instalar-bd':
      await instalarBaseDeDatos(console.log, { crearBase: values['crear-base'] });
      console.log('Listo. Ahora puedes cargar un archivo: npm run cargar -- "ruta\\al\\archivo.xlsx"');
      return 0;

    case 'probar-conexion': {
      const { bd } = leerConfig();
      const e = await probarConexion();
      console.log(`Conectado a PostgreSQL ${e.servidor} en ${bd.host}:${bd.port}, base "${e.baseDeDatos}", usuario "${e.usuario}".`);
      console.log(
        e.esquemaInstalado
          ? `Esquema del ETL versión ${e.versionEsquema}: ${miles(e.cargas ?? 0)} cargas hechas, ${miles(e.tickets ?? 0)} tickets en el modelo.`
          : 'La base no tiene las tablas del ETL. Instálalas con: npm run instalar-bd',
      );
      return 0;
    }

    case 'validar': {
      if (rutas.length === 0) throw new ErrorUso('Indica el archivo: npm run validar -- "archivo.xlsx"');
      let codigo = 0;
      for (const a of rutas) {
        const ruta = rutaDesdeUsuario(a);
        await stat(ruta); // si no existe, el error ENOENT da el mensaje "No encuentro el archivo"
        // validar no usa la base: si todavía no hay .env, solo se pierde la estación por defecto
        const estacion = values.estacion ?? (existeEnv() ? leerConfig().estacionPorDefecto : undefined);
        let hojas;
        try {
          hojas = await abrirExcel(ruta);
        } catch (err) {
          // Un archivo que no es Excel se rechaza igual que en cargar (código 1) y se sigue con los demás
          if (!(err instanceof ErrorArchivo)) throw err;
          codigo = 1;
          console.log(
            values.json
              ? JSON.stringify({ archivo: path.basename(ruta), valido: false, error: err.message }, null, 2)
              : `${path.basename(ruta)}: NO SE PUEDE CARGAR\n  ${err.message}`,
          );
          continue;
        }
        const tipo = detectarTipo(hojas);
        const lectura = tipo === 'COMPRAS' ? procesarCompras(hojas, { estacion }) : procesarHojas(hojas, { estacion });
        const valido = !tieneErrores(lectura.incidencias);
        if (!valido) codigo = 1;
        if (values.json) {
          console.log(JSON.stringify({ archivo: path.basename(ruta), tipo, valido, resumen: lectura.resumen, incidencias: lectura.incidencias }, null, 2));
        } else {
          console.log(`${path.basename(ruta)} (${NOMBRE_REPORTE[tipo]}): ${valido ? 'VÁLIDO, se puede cargar' : 'NO SE PUEDE CARGAR'}`);
          console.log(('compras' in lectura ? textoCompras(lectura) : textoLectura(lectura)).join('\n'));
        }
      }
      return codigo;
    }

    case 'cargar': {
      if (rutas.length === 0) throw new ErrorUso('Indica el archivo: npm run cargar -- "archivo.xlsx"');
      let codigo = 0;
      for (const a of rutas) {
        const r = await cargarArchivo(rutaDesdeUsuario(a), { estacion: values.estacion, usuario: values.usuario });
        if (r.estado === 'RECHAZADO') codigo = 1;
        console.log(values.json ? JSON.stringify(resumenJson(r), null, 2) : textoCarga(r));
      }
      return codigo;
    }

    case 'vigilar': {
      const imprimir = (r: Parameters<typeof textoCarga>[0]) =>
        console.log(values.json ? JSON.stringify(resumenJson(r), null, 2) : textoCarga(r));
      const opciones = { estacion: values.estacion, usuario: values.usuario };
      if (values['una-vez']) {
        const { procesados, fallidos, rechazados } = await procesarCarpeta(imprimir, opciones);
        // Con --json la salida estándar queda solo para los JSON de cada archivo
        const resumen = values.json ? console.error : console.log;
        resumen(
          `Carpeta ${leerConfig().carpetas.entrada}: ${archivos(procesados)} (cargados o repetidos: ${procesados - rechazados}, rechazados: ${rechazados})`,
        );
        // Códigos para el Programador de tareas: 2 si algo quedó sin procesar, 1 si se rechazó algún archivo
        if (fallidos > 0) {
          console.error(
            `${archivos(fallidos)} sin procesar; ${fallidos === 1 ? 'se queda' : 'se quedan'} en la carpeta de entrada para el siguiente intento.`,
          );
          return 2;
        }
        return rechazados > 0 ? 1 : 0;
      }
      const control = new AbortController();
      process.on('SIGINT', () => {
        // Se termina el archivo que se esté cargando y luego se sale
        if (!control.signal.aborted) console.log('Deteniendo...');
        control.abort();
      });
      await vigilar(imprimir, opciones, control.signal);
      return 0;
    }

    default:
      throw new ErrorUso(`No conozco el comando "${comando}".\n\n${AYUDA}`);
  }
}

class ErrorUso extends Error {}

main()
  .then(async (codigo) => {
    await cerrarPool();
    process.exitCode = codigo;
  })
  .catch(async (err: unknown) => {
    await cerrarPool().catch(() => undefined);
    if (err instanceof ErrorUso || err instanceof ErrorConfiguracion || err instanceof ErrorArchivo) {
      console.error(err.message);
    } else if ((err as { code?: string }).code === 'ENOENT') {
      console.error(`No encuentro el archivo: ${(err as { path?: string }).path ?? ''}`);
    } else if (['EBUSY', 'EPERM', 'EACCES'].includes((err as { code?: string }).code ?? '') && (err as { path?: string }).path) {
      console.error(
        `No puedo abrir el archivo ${(err as { path?: string }).path ?? ''}: está abierto en otro programa (por ejemplo Excel) o no tienes permiso.`,
      );
    } else if (esErrorDeConexion(err)) {
      console.error(explicarErrorConexion(err));
    } else {
      console.error(err);
    }
    process.exitCode = 2;
  });
