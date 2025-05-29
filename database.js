const mysql = require('mysql2');

const connection = mysql.createConnection({
    host: 'rds11g.isbelasoft.com',
    user: 'p3ag1',
    password: 'Umg123',
    database: 'prograiiiag1',
    port: 3306,
    ssl: false, // Desactiva SSL
    timezone: '-06:00'
});

connection.connect(err => {
    if (err) {
        console.error('Error conectando a la base de datos:', err.stack);
        return;
    }

    // 1) Fijamos la zona horaria de la sesión
    connection.query("SET time_zone = '-06:00'", tzErr => {
        if (tzErr) {
            console.error('No pude fijar time_zone:', tzErr);
            return;
        }

        // 2) Sólo cuando ya esté fijada la zona, confirmamos la conexión
        console.log(
            'Conectado a la base de datos MySQL (GMT-6), ID de conexión:',
            connection.threadId
        );
    });
});

module.exports = connection;

