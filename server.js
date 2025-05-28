// server.js (código corregido)
const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('./database');
const nodemailer = require('nodemailer');
const mysql = require('mysql2');
const app = express();
const port = 3001;

// Configuración de Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'joseemmanuelfelipefranco@gmail.com',
        pass: 'mrmuwhetqsyxhend'
    }
});

async function sendSecurityAlert(subject, message, base64Image) {
    try {
        const htmlContent = `
            <b>${message.replace(/\n/g, "<br>")}</b><br><br>
            ${base64Image ? `<img src="cid:fotoPersona" style="max-width:400px; border:1px solid #ccc;">` : ''}
        `;

        const mailOptions = {
            from: 'Sistema de Seguridad <joseemmanuelfelipefranco@gmail.com>',
            to: 'joseemmanuelfelipefranco@gmail.com',
            subject,
            text: message,
            html: htmlContent,
            attachments: base64Image ? [{
                filename: 'foto.jpg',
                content: Buffer.from(base64Image, 'base64'),
                cid: 'fotoPersona' // clave para usar en el HTML con cid:
            }] : []
        };

        await transporter.sendMail(mailOptions);
        console.log('Correo de alerta enviado con imagen');
    } catch (error) {
        console.error('Error enviando correo de alerta:', error);
    }
}


// Middleware
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/models', express.static(path.join(__dirname, 'public/models')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Página principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Obtener empresas
app.get('/get-empresas', (req, res) => {
    db.query("SELECT id, nombre FROM empresas", (err, rows) => {
        if (err) return res.status(500).json({ error: 'Error leyendo la base de datos' });
        res.json(rows);
    });
});

app.get('/get-areas', (req, res) => {
    db.query('SELECT id, nombre FROM areas', (err, rows) => {
        if (err) return res.status(500).json({ error: 'Error leyendo áreas' });
        res.json(rows);
    });
});


// Obtener usuarios por empresa
app.get('/get-users', (req, res) => {
    const empresaId = req.query.empresaId;
    db.query("SELECT id, nombre, cedula, cargo FROM tabla_usuarios WHERE codigo_empresa = ?", [empresaId], (err, rows) => {
        if (err) return res.status(500).send('Error al obtener usuarios');
        res.json(rows);
    });
});

app.get('/get-user-id', (req, res) => {
    const { name, empresaId } = req.query;
    db.query("SELECT id FROM tabla_usuarios WHERE nombre = ? AND codigo_empresa = ?", [name, empresaId], (err, results) => {
        if (err) return res.status(500).send('Error al obtener el ID del usuario');
        if (results.length === 0) return res.status(404).send('Usuario no encontrado');
        res.json({ id: results[0].id });
    });
});

// ❌ Esta ruta ha sido eliminada (la que usaba cedula como label)

// ✅ Esta es la única versión correcta de /get-labels
app.get('/get-labels', (req, res) => {
    const empresaId = req.query.empresaId;
    db.query("SELECT nombre FROM tabla_usuarios WHERE codigo_empresa = ?", [empresaId], (err, rows) => {
        if (err) return res.status(500).send('Error leyendo la base de datos');
        const labels = rows.map(row => row.nombre);
        res.json({ labels, totalUsers: labels.length });
    });
});

app.get('/get-image', (req, res) => {
    const { name, empresaId } = req.query;
    db.query("SELECT imagen FROM tabla_usuarios WHERE nombre = ? AND codigo_empresa = ?", [name, empresaId], (err, results) => {
        if (err || results.length === 0) return res.status(404).send('Imagen no encontrada');
        res.setHeader('Content-Type', 'image/jpeg');
        res.send(results[0].imagen);
    });
});

// Subir usuario con foto y asignar área
app.post('/upload', upload.single('photo'), (req, res) => {
    const { name, cedula, cargo, empresaId, areaId } = req.body;
    const photo = req.file.buffer;

    // Evita duplicados por cédula+empresa
    db.query(
        'SELECT COUNT(*) AS count FROM tabla_usuarios WHERE cedula = ? AND codigo_empresa = ?',
        [cedula, empresaId],
        (err, results) => {
            if (err) return res.status(500).send('Error verificando la cédula');
            if (results[0].count > 0) return res.status(400).send('El usuario ya está registrado');

            // INSERT con orden EXACTO de columnas:
            // nombre, cedula, cargo, codigo_empresa, imagen, area_id
            db.query(
                `INSERT INTO tabla_usuarios
                     (nombre, cedula, cargo, codigo_empresa, imagen, area_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [ name, cedula, cargo, empresaId, photo, areaId ],
                (err) => {
                    if (err) {
                        console.error('INSERT tabla_usuarios fallo:', err);
                        return res.status(500).send('Error al insertar en la base de datos');
                    }
                    res.send('Usuario agregado exitosamente');
                }
            );
        }
    );
});




// Registrar entrada
app.post('/register-entry', (req, res) => {
    const {
        usuarioId,
        empresaId,
        deviceCode,
        resultado_autenticacion,
        foto_intento
    } = req.body;
    console.log('▶ /register-entry recibida:', { usuarioId, empresaId, deviceCode });

    const imageBuffer = foto_intento
        ? Buffer.from(foto_intento.split(',')[1], 'base64')
        : null;

    // 1) ¿Área por defecto?
    const checkDefault = `
    SELECT COUNT(*) AS cnt
      FROM tabla_usuarios u
      JOIN dispositivos d ON u.area_id = d.area_id
     WHERE u.id = ? AND d.device_code = ?
  `;
    db.query(checkDefault, [usuarioId, deviceCode], (err, defaultRows) => {
        if (err) {
            console.error('Error validando permisos por defecto:', err);
            return res.status(500).send('Error validando permisos');
        }
        console.log('checkDefault result:', defaultRows[0].cnt);
        if (defaultRows[0].cnt > 0) {
            return getDeviceZonaAndInsert();
        }

        // 2) ¿Permiso especial?
        const checkPerms = `
      SELECT COUNT(*) AS cnt
        FROM permisos_acceso p
        JOIN dispositivos d ON p.area_id = d.area_id
       WHERE p.usuario_id  = ?
         AND d.device_code = ?
         AND p.autorizado  = 1
         AND p.vencimiento > NOW()
    `;
        db.query(checkPerms, [usuarioId, deviceCode], (err, permRows) => {
            if (err) {
                console.error('Error validando permisos especiales:', err);
                return res.status(500).send('Error validando permisos especiales');
            }
            console.log('checkPerms result:', permRows[0].cnt);
            if (permRows[0].cnt > 0) {
                return getPermZonaAndInsert();
            }
            // 3) Ningún permiso
            return res.status(403).send('No tiene permiso para ingresar en esta área');
        });
    });

    // Inserta usando la zona del dispositivo
    function getDeviceZonaAndInsert() {
        console.log('>>> Zona por defecto (dispositivo)');
        const qZona = `
      SELECT a.nombre AS zona
        FROM dispositivos d
        JOIN areas a ON d.area_id = a.id
       WHERE d.device_code = ?
    `;
        db.query(qZona, [deviceCode], (err, zonaRows) => {
            if (err) {
                console.error('Error al obtener zona de dispositivo:', err);
                return res.status(500).send('Error al obtener zona');
            }
            const ubicacion = zonaRows[0]?.zona || 'Sin zona';
            insertRegistro(ubicacion);
        });
    }

    // Inserta usando la zona del permiso puntual
    function getPermZonaAndInsert() {
        console.log('>>> Zona por permiso especial');
        const qZona = `
      SELECT a.nombre AS zona
        FROM permisos_acceso p
        JOIN areas a ON p.area_id = a.id
        JOIN dispositivos d ON d.area_id = p.area_id
       WHERE p.usuario_id  = ?
         AND d.device_code = ?
         AND p.autorizado  = 1
         AND p.vencimiento > NOW()
      LIMIT 1
    `;
        db.query(qZona, [usuarioId, deviceCode], (err, zonaRows) => {
            if (err) {
                console.error('Error al obtener zona de permiso:', err);
                return res.status(500).send('Error al obtener zona de permiso');
            }
            const ubicacion = zonaRows[0]?.zona || 'Sin zona';
            insertRegistro(ubicacion);
        });
    }

    // Función común de INSERT en registro
    function insertRegistro(ubicacion) {
        console.log('>>> insertRegistro() con ubicación =', ubicacion);
        const q = `
            INSERT INTO registro
            (usuario_id, empresa_id, hora_entrada, ubicacion, resultado_autenticacion, foto_intento)
            SELECT ?, ?, NOW(), ?, ?, ?
            FROM DUAL
            WHERE NOT EXISTS (
                SELECT 1
                FROM registro
                WHERE usuario_id    = ?
                  AND empresa_id    = ?
                  AND DATE(hora_entrada) = CURDATE()
            )
        `;
        const params = [
            usuarioId,
            empresaId,
            ubicacion,
            resultado_autenticacion,
            imageBuffer,
            usuarioId,
            empresaId
        ];
        db.query(q, params, (err, result) => {
            if (err) {
                console.error('INSERT registro falló:', err);
                return res.status(500).send(`Error al registrar la entrada: ${err.message}`);
            }
            console.log('INSERT registro OK, affectedRows=', result.affectedRows);
            if (result.affectedRows === 0) {
                return res.status(409).send('Ya hay una entrada registrada para hoy');
            }
            res.send('Entrada registrada exitosamente');
        });
    }
});

app.post('/register-failed-attempt', (req, res) => {
    const { nombre, empresaId, motivo, fotoIntento, deviceCode } = req.body;
    const imageBuffer = fotoIntento
        ? Buffer.from(fotoIntento.split(',')[1], 'base64')
        : null;

    console.log('⚠️ Intento fallido recibido:', { nombre, empresaId, motivo, deviceCode });

    const insertarIntento = `
        INSERT INTO intentos_fallidos
        (nombre, empresa_id, fecha, motivo, foto_intento, ubicacionfallida)
        VALUES (?, ?, NOW(), ?, ?, ?)
    `;

    const obtenerNombreArea = `
        SELECT a.nombre AS area
        FROM dispositivos d
        JOIN areas a ON d.area_id = a.id
        WHERE d.device_code = ?
        LIMIT 1
    `;

    (async () => {
        try {
            // 1. Obtener el nombre del área según el deviceCode
            const areaNombre = await new Promise((resolve, reject) => {
                db.query(obtenerNombreArea, [deviceCode], (err, results) => {
                    if (err) return reject(err);
                    const area = results[0]?.area || 'Desconocida';
                    resolve(area);
                });
            });

            // 2. Insertar el intento fallido
            await new Promise((resolve, reject) => {
                db.query(insertarIntento, [nombre, empresaId, motivo, imageBuffer, deviceCode], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });

            console.log('✅ Intento fallido registrado.');

            // 3. Construir mensaje de correo
            const mensaje = `
            SEGURIDAD GLOBAL S.A.
            Nombre: ${nombre}
            Área: ${areaNombre}
            Motivo: ${motivo}
            Fecha: ${new Date().toLocaleString('es-ES', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            })}
            `.trim();

            // 4. Quitar encabezado base64 si lo hay
            const base64ImageOnly = fotoIntento?.split(',')[1] || null;

            await sendSecurityAlert('⚠️ Alerta de Intento Fallido ⚠️', mensaje, base64ImageOnly);
            res.status(201).send('Intento fallido registrado.');
        } catch (err) {
            console.error('❌ Error al registrar intento fallido o enviar correo:', err);
            res.status(500).send('Error al registrar intento fallido');
        }
    })();
});




// Registrar salida
app.post('/register-exit', (req, res) => {
    const { usuarioId, empresaId, deviceCode } = req.body;

    // 0) Chequeo de permiso “por defecto”
    const checkDefault = `
        SELECT COUNT(*) AS cnt
        FROM tabla_usuarios u
                 JOIN dispositivos d ON u.area_id = d.area_id
        WHERE u.id = ? AND d.device_code = ?
    `;
    db.query(checkDefault, [usuarioId, deviceCode], (err, defaultRows) => {
        if (err) return res.status(500).send('Error validando permisos');
        if (defaultRows[0].cnt > 0) return proceedExit();

        // 1) Chequeo de permisos especiales
        const checkPerms = `
            SELECT COUNT(*) AS cnt
            FROM permisos_acceso p
                     JOIN dispositivos d ON p.area_id = d.area_id
            WHERE p.usuario_id  = ?
              AND d.device_code = ?
              AND p.autorizado  = 1
              AND p.vencimiento > NOW()
        `;
        db.query(checkPerms, [usuarioId, deviceCode], (err, permRows) => {
            if (err) return res.status(500).send('Error validando permisos especiales');
            if (permRows[0].cnt > 0) return proceedExit();
            return res.status(403).send('No tiene permiso para registrar la salida en esta área');
        });
    });

    function proceedExit() {
        // 1) Verificamos primero que exista una entrada hoy
        const checkEntry = `
      SELECT COUNT(*) AS cnt
        FROM registro
       WHERE usuario_id = ?
         AND empresa_id = ?
         AND DATE(hora_entrada) = CURDATE()
    `;
        db.query(checkEntry, [usuarioId, empresaId], (err, rows) => {
            if (err) return res.status(500).send('Error al verificar la entrada');
            if (rows[0].cnt === 0) {
                return res.status(409).send('No hay entrada para hoy');
            }

            // 2) Actualizamos hora_salida si aún no existe
            const q = `
        UPDATE registro
           SET hora_salida = NOW()
         WHERE usuario_id = ?
           AND empresa_id = ?
           AND DATE(hora_entrada) = CURDATE()
           AND hora_salida IS NULL
      `;
            db.query(q, [usuarioId, empresaId], (err, result) => {
                if (err) return res.status(500).send('Error al registrar la salida');
                if (result.affectedRows === 0) {
                    return res.status(409).send('Ya hay una salida registrada para hoy');
                }
                res.send('Salida registrada exitosamente');
            });
        });
    }
});

// Autorizar permisos
app.post('/autorizar-permiso', (req, res) => {
    const { usuarioId, zona /* viene el id del área */, vencimiento } = req.body;

    // Validar fecha
    const fechaVencimiento = new Date(vencimiento);
    if (isNaN(fechaVencimiento.getTime())) {
        return res.status(400).send('Formato de fecha inválido.');
    }

    db.query(
        `INSERT INTO permisos_acceso
      (usuario_id, autorizado, fecha_autorizacion, vencimiento, area_id)
     VALUES (?, 1, NOW(), ?, ?)`,
        [ usuarioId, fechaVencimiento, zona ],
        err => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error al guardar el permiso');
            }
            res.send('Permiso autorizado correctamente');
        }
    );
});

// Revocar permiso
app.post('/revocar-permiso', (req, res) => {
    const { usuarioId, zona } = req.body;  // zona = id del area

    db.query(
        `UPDATE permisos_acceso
       SET autorizado = 0
     WHERE usuario_id = ?
       AND area_id    = ?
       AND autorizado = 1`,      // solo los que todavía están en 1
        [ usuarioId, zona ],
        (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error al revocar el permiso');
            }
            if (result.affectedRows === 0) {
                return res.status(404).send('No se encontró permiso vigente para revocar');
            }
            res.send('Permiso revocado exitosamente');
        }
    );
});




// LOGIN — usa la columna `id` de admin_usuarios
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    db.query(
        `SELECT id AS usuarioId
       FROM admin_usuarios
      WHERE username = ?
        AND password = ?`,
        [ username, password ],
        (err, results) => {
            if (err) {
                console.error('Error en /login:', err);
                return res.status(500).send(err.message);
            }
            if (results.length === 0) {
                return res.status(401).send('Credenciales inválidas');
            }
            // Devolvemos el ID correcto
            res.json({ usuarioId: results[0].usuarioId });
        }
    );
});

// GET DEFAULT USERS — para filtrar en el front según DEVICE_CODE
app.get('/get-default-users', (req, res) => {
    const { deviceCode } = req.query;

    const sql = `
    SELECT u.id
      FROM tabla_usuarios u
      JOIN dispositivos d ON u.area_id = d.area_id
     WHERE d.device_code = ?
  `;
    db.query(sql, [ deviceCode ], (err, rows) => {
        if (err) {
            console.error('Error en /get-default-users:', err);
            return res.status(500).send('Error al obtener usuarios por defecto');
        }
        // Enviamos un array de IDs: { defaultUsers: [1,2,3,…] }
        const defaultUsers = rows.map(r => r.id);
        res.json({ defaultUsers });
    });
});




// Obtener ID por cédula
app.get('/get-user-id-by-cedula', (req, res) => {
    const { cedula, empresaId } = req.query;
    db.query("SELECT id FROM tabla_usuarios WHERE cedula = ? AND codigo_empresa = ?", [cedula, empresaId], (err, results) => {
        if (err) return res.status(500).send('Error al obtener el ID del usuario');
        if (results.length === 0) return res.status(404).send('Usuario no encontrado');
        res.json({ id: results[0].id });
    });
});





// Iniciar servidor
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
