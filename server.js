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
    const { usuarioId, empresaId, resultado_autenticacion, foto_intento } = req.body;
    const imageBuffer = foto_intento
        ? Buffer.from(foto_intento.split(',')[1], 'base64')
        : null;

    // 1) Primero obtenemos la zona/área del usuario
    db.query(
        `SELECT a.nombre AS zona
       FROM areas a
       JOIN tabla_usuarios u ON u.area_id = a.id
      WHERE u.id = ?`,
        [usuarioId],
        (err, zonaRows) => {
            if (err) return res.status(500).send('Error al obtener la zona');

            const ubicacion = zonaRows[0]?.zona || 'Sin zona';

            // 2) Insert con SELECT ... WHERE NOT EXISTS y devolviendo 409 si ya existe
            const q = `
        INSERT INTO registro
          (usuario_id, empresa_id, hora_entrada, ubicacion, resultado_autenticacion, foto_intento)
        SELECT ?, ?, NOW(), ?, ?, ?
        FROM DUAL
        WHERE NOT EXISTS (
          SELECT 1
            FROM registro
           WHERE usuario_id = ?
             AND empresa_id = ?
             AND DATE(hora_entrada) = CURDATE()
        )
      `;
            const params = [
                usuarioId, empresaId, ubicacion, resultado_autenticacion, imageBuffer,
                usuarioId, empresaId
            ];

            db.query(q, params, (err, result) => {
                if (err) {
                    console.error('Error al registrar la entrada:', err);
                    return res.status(500).send('Error al registrar la entrada');
                }
                if (result.affectedRows === 0) {
                    // Ya había una entrada hoy
                    return res.status(409).send('Ya hay una entrada registrada para hoy');
                }
                res.send('Entrada registrada exitosamente');
            });
        }
    );
});

// Registrar salida
app.post('/register-exit', (req, res) => {
    const { usuarioId, empresaId } = req.body;

    // 1) Verificamos primero que exista una entrada hoy
    const checkEntry = `
        SELECT COUNT(*) AS cnt
        FROM registro
        WHERE usuario_id = ?
          AND empresa_id = ?
          AND DATE(hora_entrada) = CURDATE()
    `;
    db.query(checkEntry, [usuarioId, empresaId], (err, rows) => {
        if (err) {
            console.error('Error al verificar la entrada:', err);
            return res.status(500).send('Error al verificar la entrada');
        }
        if (rows[0].cnt === 0) {
            return res.status(409).send('No hay entrada para hoy');
        }

        // 2) Intentamos actualizar hora_salida solo si estaba NULL
        const q = `
      UPDATE registro
         SET hora_salida = NOW()
       WHERE usuario_id = ?
         AND empresa_id = ?
         AND DATE(hora_entrada) = CURDATE()
         AND hora_salida IS NULL
    `;
        db.query(q, [usuarioId, empresaId], (err, result) => {
            if (err) {
                console.error('Error al registrar la salida:', err);
                return res.status(500).send('Error al registrar la salida');
            }
            if (result.affectedRows === 0) {
                // No se actualizó porque ya había una salida
                return res.status(409).send('Ya hay una salida registrada para hoy');
            }
            res.send('Salida registrada exitosamente');
        });
    });
});


// Autorizar permisos
app.post('/autorizar-permiso', (req, res) => {
    const { usuarioId, zona, vencimiento } = req.body;
    const autorizadoPor = 1;

    const fechaVencimiento = new Date(vencimiento);
    if (isNaN(fechaVencimiento.getTime())) {
        return res.status(400).send('Formato de fecha inválido.');
    }

    db.query(`
        INSERT INTO permisos_acceso (usuario_id, zona, autorizado, fecha_autorizacion, autorizado_por, vencimiento)
        VALUES (?, ?, 1, NOW(), ?, ?)`,
        [usuarioId, zona, autorizadoPor, fechaVencimiento],
        (err) => {
            if (err) return res.status(500).send('Error al guardar el permiso');
            res.send('Permiso autorizado correctamente');
        }
    );
});



// Validar login admin
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const query = `SELECT * FROM admin_usuarios WHERE username = ? AND password = ?`;
    db.query(query, [username, password], (err, results) => {
        if (err) return res.status(500).send('Error del servidor');
        if (results.length > 0) res.sendStatus(200);
        else res.sendStatus(401);
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



// Revocar permiso (nuevo endpoint)
app.post('/revocar-permiso', (req, res) => {
    const { usuarioId } = req.body;
    db.query(`UPDATE permisos_acceso SET autorizado = 0 WHERE usuario_id = ? AND vencimiento > NOW()`, [usuarioId], (err, result) => {
        if (err) return res.status(500).send('Error al revocar el permiso');
        if (result.affectedRows === 0) return res.status(404).send('No se encontró permiso vigente para revocar');
        res.send('Permiso revocado exitosamente');
    });
});



// Iniciar servidor
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

